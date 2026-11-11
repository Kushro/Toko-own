import { expect, test } from 'bun:test';
import {
  classifyRelease,
  nameIntroducesForeignWord,
  primaryTokenCount,
  arcTokens,
  buildTierContext,
  detectYears,
  selectByTier,
  showNamePart,
  titleEpisodeMarkers,
  type TierContext,
} from '../src/utils/torrent/tiers';
import { significantTokens } from '../src/utils/torrent/tokens';
import { hitsExclusion, matchesResolution } from '../src/utils/torrent/preferences';
import { episodeCandidates, episodeNotAired, type ShowFacts } from '../src/utils/torrent/show-facts';

const tokens = (...titles: string[]) => new Set(titles.flatMap(significantTokens));
const ctxFor = (titles: string[], episode: number, extra: Partial<TierContext> = {}): TierContext => ({
  episode,
  candidates: [episode],
  notAired: false,
  showTokens: tokens(...titles),
  primaryCount: primaryTokenCount(titles),
  arcTokens: arcTokens(titles),
  showYears: new Set(titles.flatMap(t => [...detectYears(t)])),
  singleEpisode: false,
  titleNumbers: new Set(),
  ...extra,
});

test('episode markers', () => {
  expect(titleEpisodeMarkers('[SubsPlease] Sousou no Frieren - 08 (1080p) [ABCD1234].mkv')).toEqual([[8, 8]]);
  expect(titleEpisodeMarkers('[Group] Show S02E03 [1080p]')).toEqual([[3, 3]]);
  expect(titleEpisodeMarkers('[Group] Show (01-12) [BD 1080p]')).toEqual([[1, 12]]);
  expect(titleEpisodeMarkers('[HatSubs] One Piece 1172 (WEB 1080p)')).toEqual([[1172, 1172]]);
  expect(titleEpisodeMarkers('[Group] Show [1080p][HEVC]')).toEqual([]);
});

test('show name part cuts the group tag and the last episode marker', () => {
  expect(showNamePart('[SubsPlease] Made in Abyss - Retsujitsu no Ougonkyou - 04 (1080p)')).toBe('Made in Abyss - Retsujitsu no Ougonkyou');
  expect(showNamePart('[Erai-raws] Another - 03 [1080p]')).toBe('Another');
  expect(showNamePart('Show.Name.S01E02.1080p.WEB')).toBe('Show Name');
});

test('a one-word show does not take a release that adds words', () => {
  const show = tokens('Another');
  expect(nameIntroducesForeignWord('[Group] In Another World With My Smartphone - 03 [1080p]', show)).toBe(true);
  expect(nameIntroducesForeignWord('[Group] Another - 03 [1080p]', show)).toBe(false);
  expect(nameIntroducesForeignWord('[Group] Another (Uncensored) - 03 [1080p]', show)).toBe(false);
  const ctx = ctxFor(['Another'], 3);
  expect(classifyRelease('[Group] In Another World With My Smartphone - 03 [1080p]', ctx, { matchTitle: 'Another' })).toBeNull();
  expect(classifyRelease('[Group] Another - 03 [1080p]', ctx, { matchTitle: 'Another' })?.tier).toBe('A');
});

test('tiers: exact, covering pack, unlabelled, other episode', () => {
  const ctx = ctxFor(['Sousou no Frieren', "Frieren: Beyond Journey's End"], 8);
  const opt = { matchTitle: 'Sousou no Frieren' };
  expect(classifyRelease('[SubsPlease] Sousou no Frieren - 08 (1080p)', ctx, opt)).toEqual({ tier: 'A', hit: 8 });
  expect(classifyRelease('[Judas] Sousou no Frieren (01-28) [BD 1080p] [Batch]', ctx, opt)).toEqual({ tier: 'B', hit: 8 });
  expect(classifyRelease('[Group] Sousou no Frieren [BD 1080p][Complete]', ctx, opt)).toEqual({ tier: 'C', hit: null });
  expect(classifyRelease('[SubsPlease] Sousou no Frieren - 07 (1080p)', ctx, opt)).toBeNull();
  expect(classifyRelease('[SubsPlease] Dandadan - 08 (1080p)', ctx, opt)).toBeNull();
});

test('selection drops guesses once an exact match exists, keeps them otherwise', () => {
  const ctx = ctxFor(['Sousou no Frieren'], 8);
  const mk = (title: string) => ({ item: title, title, publishedAt: 0, matchTitle: 'Sousou no Frieren' });
  const all = selectByTier([
    mk('[Group] Sousou no Frieren [BD 1080p][Complete]'),
    mk('[Judas] Sousou no Frieren (01-28) [Batch]'),
    mk('[SubsPlease] Sousou no Frieren - 08 (1080p)'),
  ], ctx).map(o => o.tier);
  expect(all).toEqual(['A', 'B']);
  const none = selectByTier([
    mk('[Group] Sousou no Frieren [BD 1080p][Complete]'),
    mk('[Judas] Sousou no Frieren (01-28) [Batch]'),
  ], ctx).map(o => o.tier);
  expect(none).toEqual(['B', 'C']);
});

test('cour offsets: the freshest candidate wins', () => {
  const bleach = ['Bleach: Sennen Kessen-hen - Soukoku-tan'];
  const facts: ShowFacts = {
    nextAiring: null,
    startYear: 2024,
    format: 'TV',
    prequels: [
      { episodes: 13, tokens: tokens('Bleach: Sennen Kessen-hen - Ketsubetsu-tan') },
      { episodes: 13, tokens: tokens('Bleach: Sennen Kessen-hen') },
      { episodes: 366, tokens: tokens('Bleach') },
    ],
  };
  const show = tokens(...bleach);
  const candidates = episodeCandidates(facts, 1, show);
  expect(candidates).toEqual([1, 27, 393]);

  const now = Date.parse('2026-11-10T00:00:00Z');
  const ctx: TierContext = { episode: 1, candidates, notAired: false, showTokens: show, primaryCount: primaryTokenCount(bleach), arcTokens: arcTokens(bleach) };
  const rows = [
    { title: '[Group] Bleach - Sennen Kessen-hen - 01 [1080p]', publishedAt: Date.parse('2022-10-11T00:00:00Z') },
    { title: '[Group] Bleach - Sennen Kessen-hen - 27 [1080p]', publishedAt: now - 3600_000 },
  ].map(r => ({ ...r, item: r.title, matchTitle: 'Bleach Sennen Kessen-hen' }));
  const picked = selectByTier(rows, ctx, now);
  expect(picked.map(p => [p.item, p.hit])).toEqual([['[Group] Bleach - Sennen Kessen-hen - 27 [1080p]', 27]]);
  // The 2004 series under the short query "Bleach" is not this show.
  expect(classifyRelease('[Boypreggers-Raws] Bleach - 001 [JPBD]', { ...ctx, candidates: [1] }, { matchTitle: 'Bleach' })).toBeNull();
});

test('unaired episode: only a fresh exact upload survives', () => {
  expect(episodeNotAired({ nextAiring: 9, startYear: 2026, format: 'TV', prequels: [] }, 9)).toBe(true);
  expect(episodeNotAired({ nextAiring: 9, startYear: 2026, format: 'TV', prequels: [] }, 8)).toBe(false);
  const now = Date.parse('2026-11-10T00:00:00Z');
  const ctx = ctxFor(['Tokyo Revengers'], 1, { notAired: true });
  const rows = [
    { title: '[Group] Tokyo Revengers - 01 [1080p]', publishedAt: Date.parse('2021-04-11T00:00:00Z') },
    { title: '[Group] Tokyo Revengers (01-24) [Batch]', publishedAt: now - 3600_000 },
  ].map(r => ({ ...r, item: r.title, matchTitle: 'Tokyo Revengers' }));
  expect(selectByTier(rows, ctx, now)).toEqual([]);
  const fresh = [{ title: '[Group] Tokyo Revengers S04E01 [1080p]', publishedAt: now - 3600_000 }]
    .map(r => ({ ...r, item: r.title, matchTitle: 'Tokyo Revengers' }));
  expect(selectByTier(fresh, ctx, now).map(p => p.tier)).toEqual(['A']);
});

test('an episode-id lookup is exact whatever the filename says', () => {
  const ctx = ctxFor(['Bleach: Sennen Kessen-hen - Soukoku-tan'], 1);
  const picked = selectByTier([{ item: 'x', title: '[Group] Bleach TYBW - 27 [1080p]', publishedAt: 0, exactEpisode: true }], ctx);
  expect(picked.map(p => p.tier)).toEqual(['A']);
});

test('a sibling arc is not this entry', () => {
  const titles = ['Bleach: Sennen Kessen-hen - Soukoku-tan', 'BLEACH: Thousand-Year Blood War - The Conflict'];
  const ctx = ctxFor(titles, 1);
  expect(classifyRelease('[Erai-raws] Bleach: Sennen Kessen Hen - Kashin Tan - 01 [1080p]', ctx)).toBeNull();
  expect(classifyRelease('[Erai-raws] Bleach - Sennen Kessen Hen - Soukoku Tan - 01v2 [1080p]', ctx)?.tier).toBe('A');
  // Frieren's English subtitle is not an arc: the romaji release names none of it and adds nothing.
  const frieren = ctxFor(['Sousou no Frieren', "Frieren: Beyond Journey's End"], 8);
  expect(classifyRelease('[SubsPlease] Sousou no Frieren - 08 (1080p)', frieren)?.tier).toBe('A');
});

const facts = (over: Partial<ShowFacts>): ShowFacts => ({ nextAiring: null, startYear: null, format: 'TV', episodes: 12, prequels: [], ...over });

test('a year in the title is a filter, not a requirement of the name', async () => {
  const ctx = await buildTierContext({ titles: ['False Memory (2026)'], episode: 1 }, facts({ startYear: 2026, episodes: 7 }));
  expect(classifyRelease('[ToonsHub] False Memory S01E01 (1080p)', ctx)?.tier).toBe('A');
  expect(classifyRelease('[Group] False Memory (2020) - 01 [1080p]', ctx)?.tier).toBe('C');
});

test('a one-episode work rejects series releases and other years', async () => {
  const ctx = await buildTierContext({ titles: ['False Memory'], episode: 1 }, facts({ startYear: 2020, episodes: 1, format: 'ONA' }));
  expect(classifyRelease('[Group] False Memory (2020) [1080p]', ctx)?.tier).toBe('A');
  expect(classifyRelease('[Group] False Memory - 05 [1080p]', ctx)).toBeNull();
  expect(classifyRelease('[Group] False Memory S01 [1080p]', ctx)).toBeNull();
  expect(classifyRelease('[Group] False Memory (2026) [1080p]', ctx)?.tier).toBe('C');
  expect(classifyRelease('[Group] False Memory - 01 [1080p]', ctx)?.tier).toBe('B');
  const movie = await buildTierContext({ titles: ['Detective Conan Movie 27: The Million-dollar Pentagram'] }, facts({ format: 'MOVIE', startYear: 2024, episodes: 1 }));
  expect(classifyRelease('[Group] Detective Conan Movie 27 The Million-dollar Pentagram [BD 1080p]', movie)?.tier).toBe('A');
});

test('a number in the show name is not a pack range', async () => {
  const ctx = await buildTierContext({ titles: ['Kaiju No. 8'], episode: 9 }, facts({}));
  expect(classifyRelease('[Group] Kaiju No. 8 - 10 [1080p]', ctx)).toBeNull();
  expect(classifyRelease('[Group] Kaiju No. 8 - 09 [1080p]', ctx)?.tier).toBe('A');
});

test('preferences: exclusions and resolution', () => {
  expect(hitsExclusion('[Group] Show - 01 [720p][HEVC]', ['hevc'])).toBe(true);
  expect(hitsExclusion('[Group] Show - 01 [720p]', ['hevc', ''])).toBe(false);
  expect(matchesResolution('[Group] Show - 01 (1080p)', '1080p')).toBe(true);
  expect(matchesResolution('[Group] Show - 01 (720p)', '1080')).toBe(false);
  expect(matchesResolution('[Group] Show - 01 (720p)', '')).toBe(true);
});
