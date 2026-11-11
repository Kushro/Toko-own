/**
 * Release tiers for an episode request.
 *
 *   A = names the requested episode (under the AniList number or a cour offset) and is not a pack
 *   B = a pack whose episode range covers it
 *   C = the show, but no episode stated (unlabelled pack, movie, rip) — a guess
 *   null = another show, or a filename that names a different episode
 *
 * Once an A exists, C is noise and is dropped. When nothing exact turned up, B and C stay so the list does not go
 * empty. The app aligns files inside a pack, so a B result still plays the right episode.
 */
import { parseEpisodeFromTitle } from './matcher.js';
import { significantTokens } from './tokens.js';
import { episodeCandidates, episodeNotAired, getShowFacts, type ShowFacts } from './show-facts.js';

export type Tier = 'A' | 'B' | 'C';
export { significantTokens };

// ── Words ─────────────────────────────────────────────────────────────────────

/** Release metadata that may sit in the show-name part of a filename without naming another show. */
const RELEASE_WORDS = new Set([
  'uncensored', 'censored', 'dual', 'audio', 'multi', 'sub', 'subs', 'subbed', 'dub', 'dubbed', 'english', 'eng',
  'batch', 'complete', 'web', 'webrip', 'bluray', 'hevc', 'avc', 'remastered', 'repack', 'proper', 'final',
  'raw', 'raws', 'hdr', 'uhd', 'aac', 'flac', 'opus', 'tv', 'bd', 'dvd',
]);

function tokenSet(titles: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of titles) for (const tok of significantTokens(t)) out.add(tok);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(tok: string, lowerTitle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(tok)}(?![\\p{L}\\p{N}])`, 'u').test(lowerTitle);
}

/**
 * Multi-sub groups append bracketed language codes ([ENG][SPA-LA][DAN]...). "[DAN]" would match the "dan" of
 * DAN DA DAN, so they go before matching.
 */
function stripLangCodes(title: string): string {
  return title.replace(/\[[A-Z]{2,3}(?:-[A-Z]{2,3})?\]/g, ' ');
}

/**
 * The part of a filename that names the show: group tag dropped, everything from the LAST episode marker on cut
 * (so an arc subtitle stays in: "Made in Abyss - Retsujitsu no Ougonkyou - 04").
 */
export function showNamePart(title: string): string {
  let t = String(title || '').replace(/^\s*[[(【][^\])】]*[\])】]\s*/, '');
  const se = t.search(/\bS\d{1,2}E\d{1,4}\b/i);
  if (se > 0) t = t.slice(0, se);
  const dash = /[\s._][-~]\s*\d{1,4}(?:v\d)?(?=[\s[(.]|$)/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = dash.exec(t)) !== null) last = m.index;
  if (last > 0) t = t.slice(0, last);
  const epWord = t.search(/\bEP?\.?\s*\d{1,4}\b/i);
  if (epWord > 0) t = t.slice(0, epWord);
  t = t.split(/[[(]/)[0];
  return t.replace(/[._]/g, ' ').trim().replace(/[\s:_-]+$/, '');
}

/**
 * A show whose name is one word is satisfied by any release containing it: "Another" matched "In Another World
 * With My Smartphone", "Monster" matched "Monster Musume". For those the filename's show name must not add a
 * significant word the show's titles do not have.
 */
export function nameIntroducesForeignWord(title: string, showTokens: Set<string>): boolean {
  for (const tok of significantTokens(showNamePart(title))) {
    if (/^\d+$/.test(tok) || RELEASE_WORDS.has(tok)) continue;
    if (!showTokens.has(tok)) return true;
  }
  return false;
}

// ── Episodes ──────────────────────────────────────────────────────────────────

/** Episode numbers a filename states, as [from, to] (a single episode is [n, n]). Empty when none is stated. */
export function titleEpisodeMarkers(title: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const push = (a: string, b?: string) => {
    const lo = parseInt(a, 10);
    const hi = b == null ? lo : parseInt(b, 10);
    if (Number.isInteger(lo) && Number.isInteger(hi) && hi >= lo && !out.some(([x, y]) => x === lo && y === hi)) out.push([lo, hi]);
  };
  const name = title.replace(/\.(mkv|mp4|avi|m4v|webm|mov)$/i, '');
  let m: RegExpExecArray | null;
  const se = /\bs\d{1,2}[\s._-]*e(\d{1,4})(?:\s*[-~]\s*(?:s\d{1,2})?e?(\d{1,4}))?\b/gi;
  while ((m = se.exec(name)) !== null) push(m[1], m[2]);
  const ep = /\bep(?:isode)?\.?\s*(\d{1,4})\b/gi;
  while ((m = ep.exec(name)) !== null) push(m[1]);
  const dash = /[\s._]-\s*(\d{1,4})(?:v\d)?\s*(?=[[(]|$)/g;
  while ((m = dash.exec(name)) !== null) push(m[1]);
  const range = /(?<![\d.])(\d{1,4})\s*[-~]\s*(\d{1,4})(?![\d.]|p\b)/g;
  while ((m = range.exec(name)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (b > a && b - a < 400) push(m[1], m[2]);
  }
  if (!out.length) {
    // Looser forms the shared parser knows: "(E1156)", "One Piece 1172", "_1173_".
    const p = parseEpisodeFromTitle(name);
    if (p.episodeNumber !== null) {
      // A year is not an episode.
      const n = p.episodeNumber;
      if (!(n >= 1930 && n <= 2099)) out.push([n, p.episodeEnd ?? n]);
    }
  }
  return out;
}

function isPack(title: string, markers: Array<[number, number]>): boolean {
  return markers.some(([lo, hi]) => hi > lo) || /\b(?:batch|complete)\b/i.test(title);
}

// ── Context + classification ──────────────────────────────────────────────────

export interface TierContext {
  /** Requested AniList episode; 0 for a whole-show search. */
  episode: number;
  /** Numbers a group may use for it, AniList number first. */
  candidates: number[];
  /** True when AniList says the episode is not out yet. */
  notAired: boolean;
  /** Words of every title of the show. */
  showTokens: Set<string>;
  /**
   * Word count of the show's main title (first mostly-Latin one). It sets how many show words a release must carry:
   * two for 3+ words, one otherwise. Taken from the real title, not the search query: "Bleach" as the short query
   * for "Bleach: Sennen Kessen-hen - Soukoku-tan" let every 2004 "Bleach - 001" through.
   */
  primaryCount: number;
  /** Words only an entry's subtitle has ("soukoku" of "Bleach: Sennen Kessen-hen - Soukoku-tan"). */
  arcTokens: Set<string>;
}

/**
 * Words of each title's last segment (after the last ":" or " - ") that the rest of it does not have. They tell an arc apart
 * from its siblings: "Bleach: Sennen Kessen-hen - Soukoku-tan" against a "... Kashin-tan" release.
 */
export function arcTokens(titles: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of titles) {
    const m = String(t || '').match(/^(.*)(?::|\s[-–]\s)(.+)$/);
    if (!m) continue;
    const head = new Set(significantTokens(m[1]));
    for (const tok of significantTokens(m[2])) if (!head.has(tok) && !/^\d+$/.test(tok)) out.add(tok);
  }
  return out;
}

/** Word count of the first mostly-Latin title (romaji / English), else of the first title with any words. */
export function primaryTokenCount(titles: string[]): number {
  const counted = titles.map(t => {
    const compact = String(t || '').replace(/\s/g, '');
    const latin = compact.replace(/[^\p{Script=Latin}\p{N}\p{P}\p{S}]/gu, '');
    return { n: significantTokens(t).length, latin: compact.length ? latin.length / compact.length >= 0.5 : false };
  }).filter(x => x.n > 0);
  return (counted.find(x => x.latin) ?? counted[0])?.n ?? 0;
}

export interface TierOptions {
  anilistId?: number;
  titles: string[];
  episode?: number;
}

/** Build the tier context; the AniList lookup is skipped for a whole-show search. Never throws. */
export async function buildTierContext(opts: TierOptions, facts?: ShowFacts | null): Promise<TierContext> {
  const episode = opts.episode && opts.episode > 0 ? opts.episode : 0;
  const showTokens = tokenSet(opts.titles ?? []);
  const f = facts !== undefined ? facts : episode > 0 ? await getShowFacts(opts.anilistId) : null;
  return {
    episode,
    candidates: episode > 0 ? episodeCandidates(f, episode, showTokens) : [],
    notAired: episode > 0 && episodeNotAired(f, episode),
    showTokens,
    primaryCount: primaryTokenCount(opts.titles ?? []),
    arcTokens: arcTokens(opts.titles ?? []),
  };
}

export interface Classified {
  tier: Tier;
  /** The episode number the release matched (a candidate), or null. */
  hit: number | null;
}

/**
 * Tier one release. `matchTitle` (the query that found it) only stands in for the main title when the context has
 * none. `knownShow` skips the show check for id-based lookups (AnimeTosho by
 * AniDB id), whose results are this show by construction.
 */
export function classifyRelease(
  title: string,
  ctx: TierContext,
  opts: { matchTitle?: string; wanted?: number[]; knownShow?: boolean } = {},
): Classified | null {
  if (!opts.knownShow) {
    const primary = ctx.primaryCount || significantTokens(opts.matchTitle ?? '').length;
    const minHits = primary >= 3 ? 2 : 1;
    if (ctx.showTokens.size) {
      const lower = stripLangCodes(title).toLowerCase();
      let hits = 0;
      for (const tok of ctx.showTokens) if (hasWord(tok, lower)) hits++;
      if (hits < minHits) return null;
    }
    if (primary === 1 && nameIntroducesForeignWord(title, ctx.showTokens)) return null;
    // A sibling arc: names none of this entry's subtitle words and brings one of its own.
    if (ctx.arcTokens?.size) {
      const lower = stripLangCodes(title).toLowerCase();
      const namesArc = [...ctx.arcTokens].some(tok => hasWord(tok, lower));
      if (!namesArc && nameIntroducesForeignWord(title, ctx.showTokens)) return null;
    }
  }

  if (!(ctx.episode > 0)) return { tier: 'A', hit: null };
  const wanted = opts.wanted ?? ctx.candidates;
  const markers = titleEpisodeMarkers(title);
  if (!markers.length) return { tier: 'C', hit: null };

  const pack = isPack(title, markers);
  if (!pack) {
    for (const w of wanted) if (markers.some(([lo, hi]) => lo === w && hi === w)) return { tier: 'A', hit: w };
  }
  for (const w of wanted) if (markers.some(([lo, hi]) => hi > lo && w >= lo && w <= hi)) return { tier: 'B', hit: w };
  if (pack && !markers.some(([lo, hi]) => hi > lo)) return { tier: 'C', hit: null };
  // The filename names an episode and it is not this one.
  return null;
}

// ── Selection ─────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface TierInput<T> {
  item: T;
  title: string;
  /** Upload time in ms, 0 when unknown. */
  publishedAt: number;
  matchTitle?: string;
  knownShow?: boolean;
  /** Found by an episode id lookup (AnimeTosho by AniDB episode): the requested episode whatever its name says. */
  exactEpisode?: boolean;
}

export interface TierOutput<T> extends Classified {
  item: T;
}

const TIER_ORDER: Record<Tier, number> = { A: 0, B: 1, C: 2 };

/**
 * Tier every release and keep the ones worth showing, A first (provider order kept within a tier).
 *
 * Several candidate numbers usually all find something, since an older cour also has an "01". Only one is right,
 * and it is the one that was just uploaded: each candidate is scored by its newest exact match and the freshest is
 * kept (plus any within a week of it).
 *
 * For an episode AniList says has not aired, only an exact match uploaded in the last week survives: groups beat
 * the broadcast schedule, while a years-old file that reuses the number is what the check exists for.
 */
export function selectByTier<T>(inputs: TierInput<T>[], ctx: TierContext, now = Date.now()): TierOutput<T>[] {
  const classify = (x: TierInput<T>, wanted?: number[]): Classified | null => {
    if (x.exactEpisode && ctx.episode > 0 && (!wanted || wanted.includes(ctx.episode))) return { tier: 'A', hit: ctx.episode };
    return classifyRelease(x.title, ctx, { matchTitle: x.matchTitle, wanted, knownShow: x.knownShow });
  };

  let chosen = ctx.candidates;
  if (ctx.candidates.length > 1) {
    const newest = new Map<number, number>();
    for (const n of ctx.candidates) {
      for (const x of inputs) {
        if (classify(x, [n])?.tier !== 'A') continue;
        newest.set(n, Math.max(newest.get(n) ?? -1, x.publishedAt || 0));
      }
    }
    if (newest.size) {
      const best = Math.max(...newest.values());
      chosen = ctx.candidates.filter(n => newest.has(n) && best - newest.get(n)! <= WEEK_MS);
    } else {
      chosen = [ctx.episode];
    }
  }

  const out: TierOutput<T>[] = [];
  for (const x of inputs) {
    const c = classify(x, chosen);
    if (c) out.push({ ...c, item: x.item });
  }

  if (ctx.notAired) {
    return out.filter(o => {
      if (o.tier !== 'A') return false;
      const at = inputs.find(x => x.item === o.item)?.publishedAt ?? 0;
      return at > 0 && now - at <= WEEK_MS;
    });
  }

  const kept = out.some(o => o.tier === 'A') ? out.filter(o => o.tier !== 'C') : out;
  return kept
    .map((o, i) => ({ o, i }))
    .sort((a, b) => TIER_ORDER[a.o.tier] - TIER_ORDER[b.o.tier] || a.i - b.i)
    .map(({ o }) => o);
}

/** Cap a 0–100 score by tier, so a guess never outranks an exact match in the merged list. */
export function capByTier(score: number, tier: Tier): number {
  if (tier === 'B') return Math.min(score, 70);
  if (tier === 'C') return Math.min(score, 30);
  return score;
}
