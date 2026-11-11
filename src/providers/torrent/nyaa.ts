/**
 * Nyaa torrent provider — magnet links, episode filtering + scoring.
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import { scoreTitleMatch, scoreTorrentResult, buildMagnet } from '../../utils/torrent/matcher.js';
import { buildTierContext, capByTier, selectByTier, type Tier } from '../../utils/torrent/tiers.js';
import { hitsExclusion, matchesResolution } from '../../utils/torrent/preferences.js';
import { aliasTitles, searchTitles, seasonOf, stripSeason, releaseSeason, seasonMismatch } from '../../utils/torrent/search-titles.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const BASES = ['https://nyaa.si', 'https://nyaa.land'];

/** How a feed request ended; `limited` and `challenge` say why a search came back empty. */
type FeedStatus = 'ok' | 'limited' | 'challenge' | 'error';

/**
 * One RSS query, nyaa.si first and its mirror after. nyaa sits behind ddos-guard, which answers a client it does not
 * trust with an HTML challenge page instead of RSS; that and a 429 are told apart from "no results".
 */
async function fetchRssItems(query: string): Promise<{ items: string[]; status: FeedStatus }> {
  let status: FeedStatus = 'error';
  for (const base of BASES) {
    const url = `${base}/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
    try {
      const res = await fetchResponse(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(8000),
      } as RequestInit);
      if (res.status === 429) { status = 'limited'; continue; }
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes('<rss') && !text.includes('<item>')) { if (status !== 'limited') status = 'challenge'; continue; }
      return { items: text.match(/<item>([\s\S]*?)<\/item>/g) ?? [], status: 'ok' };
    } catch { continue; }
  }
  return { items: [], status };
}

interface RawRelease {
  animeTitle: string;
  torrentTitle: string;
  torrentUrl: string;
  infoHash: string;
  seeders: number;
  leechers: number;
  fileSize: string;
  publishedAt: number;
  /** Uploaded by an account nyaa marks trusted (green). */
  trusted: boolean;
  /** Marked a remake (red): a re-encode or re-upload of another group's release. */
  remake: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseItem(item: string, animeTitle: string): RawRelease | null {
  const rawTitle =
    item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
    item.match(/<title>(.*?)<\/title>/)?.[1] ??
    '';
  const torrentTitle = decodeEntities(rawTitle);
  if (!torrentTitle) return null;
  const torrentUrl =
    item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ??
    item.match(/<link>\s*(https?:\/\/[^<]+)\s*<\/link>/)?.[1] ??
    '';
  const infoHash =
    item.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/)?.[1] ??
    torrentUrl.match(/download\/([a-f0-9]{40})/i)?.[1] ??
    '';
  const pub = Date.parse(item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '');
  return {
    animeTitle,
    torrentTitle,
    torrentUrl,
    infoHash,
    seeders: parseInt(item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/)?.[1] ?? '0', 10),
    leechers: parseInt(item.match(/<nyaa:leechers>(.*?)<\/nyaa:leechers>/)?.[1] ?? '0', 10),
    fileSize: item.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] ?? '',
    publishedAt: Number.isFinite(pub) ? pub : 0,
    trusted: /<nyaa:trusted>\s*Yes/i.test(item),
    remake: /<nyaa:remake>\s*Yes/i.test(item),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const TIER_RANK: Record<Tier, number> = { A: 0, B: 1, C: 2 };

const provider: TorrentProvider = {
  name: 'nyaa',
  sites: BASES,
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    // "... Part 2" is searched as the bare title plus SxxEyy; the season filter below keeps other seasons out.
    const season = seasonOf(opts.titles ?? []);
    const titles = searchTitles((opts.titles ?? []).map(stripSeason));
    const ep = opts.episode ?? 0;
    if (titles.length === 0) return [];
    const ctx = await buildTierContext({ anilistId: opts.anilistId, titles: opts.titles ?? [], episode: ep });

    const seen = new Set<string>();
    const raw: RawRelease[] = [];
    let stopped = null as FeedStatus | null;
    let lastStatus = 'ok' as FeedStatus;
    const run = async (query: string, animeTitle: string) => {
      if (stopped) return;
      const { items, status } = await fetchRssItems(query);
      lastStatus = status;
      // A rate limit is per IP and lasts about a minute: every further query would only extend it.
      if (status === 'limited') { stopped = status; return; }
      for (const item of items) {
        const r = parseItem(item, animeTitle);
        if (!r) continue;
        const key = r.infoHash.toLowerCase() || r.torrentTitle;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push(r);
      }
    };
    const select = () => selectByTier(
      raw
        .filter(r => !hitsExclusion(r.torrentTitle, opts.exclusions))
        .map(r => ({ item: r, title: r.torrentTitle, publishedAt: r.publishedAt, matchTitle: r.animeTitle })),
      ctx,
    ).filter(({ item, hit }) => {
      if (!(ep > 0)) return true;
      // Another season said explicitly: out. For a later season the release must say so ("S02E03", "S2 - 03",
      // "2nd Season"): an unmarked "Title - 03" is season 1 episode 3 under the same bare title. A release found
      // under a cour offset ("Title - 41") is numbered across seasons and names none.
      if (seasonMismatch(item.torrentTitle, season)) return false;
      if (season && season > 1 && (hit === null || hit === ep) && releaseSeason(item.torrentTitle) === null) return false;
      return true;
    });
    const hasExact = () => select().some(p => p.tier === 'A');

    // Phase 1: every title as is. The feed's first page holds the newest uploads, which for an airing show already
    // has the episode, and every title is searched because groups split between naming conventions.
    for (const t of titles) await run(t, t);

    // Phase 2: episode-numbered queries, only when phase 1 did not reach the episode (an older one fell off the
    // first page). One title's set at a time; the first title whose set finds it ends the phase.
    // An episode that has not aired can only be a fresh upload, which phase 1 already sees.
    if (ep > 0 && !ctx.notAired && !hasExact()) {
      const ss = season ? pad2(season) : '';
      const numbered = (t: string) => (season && season > 1
        ? [`${t} S${ss}E${pad2(ep)}`, `${t} S${season} - ${pad2(ep)}`, `${t} - ${pad2(ep)}`]
        : [`${t} - ${pad2(ep)}`, `${t} ${pad2(ep)}`, `${t} - ${String(ep).padStart(3, '0')}`]);
      for (const t of [...titles, ...aliasTitles(opts.anilistId)]) {
        for (const q of numbered(t)) await run(q, t);
        if (stopped || hasExact()) break;
      }
    }

    // Phase 3: a cour-split show, numbered across the arc ("BLEACH TYBW - 41"). The first query that finds it ends it.
    if (ep > 0 && !ctx.notAired && ctx.candidates.length > 1 && !hasExact()) {
      outer: for (const t of [...titles.slice(0, 2), ...aliasTitles(opts.anilistId)]) {
        for (const n of ctx.candidates.slice(1)) {
          await run(`${t} ${pad2(n)}`, t);
          if (stopped) break outer;
          if (hasExact()) break outer;
        }
      }
    }

    if (!raw.length && (stopped === 'limited' || lastStatus === 'challenge')) {
      throw new Error(stopped === 'limited'
        ? 'nyaa.si is rate-limiting requests; try again in a minute.'
        : 'nyaa.si answered with a ddos-guard challenge instead of results; try again in a minute.');
    }

    const results: Array<{ r: SourceResult; tier: Tier; raw: RawRelease }> = [];
    for (const { item: r, tier, hit } of select()) {
      const magnetLink = r.infoHash ? buildMagnet(r.infoHash, r.torrentTitle) : '';
      const url = magnetLink || r.torrentUrl;
      if (!url) continue;
      const releaseGroup = r.torrentTitle.match(/^\[([^\]]{1,40})\]/)?.[1];
      const score = tier === 'C'
        ? Math.round(scoreTitleMatch(r.torrentTitle, r.animeTitle) * 0.3)
        : scoreTorrentResult(r.torrentTitle, r.animeTitle, hit ?? (ctx.singleEpisode ? 0 : ep), r.seeders);
      results.push({
        tier,
        raw: r,
        r: {
          source: 'nyaa',
          url,
          quality: normalizeQuality(r.torrentTitle),
          headers: {},
          subtitles: [],
          sourceType: 'torrent' as const,
          audioLanguage: 'ja',
          torrentTitle: r.torrentTitle,
          magnetLink: magnetLink || undefined,
          seeders: r.seeders,
          leechers: r.leechers,
          peers: r.seeders + r.leechers,
          fileSize: r.fileSize,
          matchScore: capByTier(score, tier),
          releaseGroup,
        },
      });
    }

    // Tier, then the requested resolution, then trusted over plain over remake, then score, then peers.
    const quality = (x: RawRelease) => (x.remake ? 2 : x.trusted ? 0 : 1);
    results.sort((a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      Number(matchesResolution(b.raw.torrentTitle, opts.resolution)) - Number(matchesResolution(a.raw.torrentTitle, opts.resolution)) ||
      quality(a.raw) - quality(b.raw) ||
      (b.r.matchScore ?? 0) - (a.r.matchScore ?? 0) ||
      (b.r.peers ?? 0) - (a.r.peers ?? 0));

    return results.slice(0, 50).map(x => x.r);
  },
};

export default provider;
