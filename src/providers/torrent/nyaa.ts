/**
 * Nyaa torrent provider — magnet links, episode filtering + scoring.
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import { scoreTitleMatch, scoreTorrentResult, buildMagnet } from '../../utils/torrent/matcher.js';
import { buildTierContext, capByTier, selectByTier } from '../../utils/torrent/tiers.js';
import { searchTitles, seasonOf, stripSeason, releaseSeason, seasonMismatch } from '../../utils/torrent/search-titles.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const MAGNET_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

const BASES = ['https://nyaa.si', 'https://nyaa.land'];

async function fetchRssItems(query: string): Promise<string[]> {
  const endpoints = BASES.map(
    (base) => `${base}/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`,
  );
  for (const url of endpoints) {
    try {
      const res = await fetchResponse(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(8000),
      } as RequestInit);
      if (!res.ok) continue;
      const text = await res.text();
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
      if (items.length > 0) return items;
    } catch { continue; }
  }
  return [];
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
}

function parseItem(item: string, animeTitle: string): RawRelease | null {
  const torrentTitle =
    item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
    item.match(/<title>(.*?)<\/title>/)?.[1] ??
    '';
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
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

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

    // Per title: episode-specific queries first, then the broad one. Each result is tiered against the title that
    // found it.
    const epPad3 = ep > 0 ? String(ep).padStart(3, '0') : '';
    const epPad2 = ep > 0 ? pad2(ep) : '';
    const ss = season ? pad2(season) : '';
    const plan = titles.flatMap(animeTitle => (ep > 0
      ? (season && season > 1
        ? [`${animeTitle} S${ss}E${epPad2}`, `${animeTitle} S${season} - ${epPad2}`, `${animeTitle} - ${epPad2}`, animeTitle]
        : [`${animeTitle} - ${epPad2}`, `${animeTitle} ${epPad2}`, `${animeTitle} - ${epPad3}`, animeTitle])
      : [animeTitle]).map(query => ({ animeTitle, query })));

    const seen = new Set<string>();
    const raw: RawRelease[] = [];
    const absorb = (items: string[], animeTitle: string) => {
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
      raw.map(r => ({ item: r, title: r.torrentTitle, publishedAt: r.publishedAt, matchTitle: r.animeTitle })),
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

    let picked = [] as ReturnType<typeof select>;
    for (const { animeTitle, query } of plan) {
      absorb(await fetchRssItems(query), animeTitle);
      picked = select();
      // Up to 50: a weekly episode easily has 25+ releases (groups x 480p/720p/1080p); 20 cut most of them.
      if (picked.filter(p => p.tier === 'A').length >= 50) break;
    }

    // A cour-split show: groups may number this episode across the arc ("BLEACH TYBW - 41"), and a feed only
    // returns its recent page, so an older offset episode needs its own query. Stops at the first that finds it.
    if (ep > 0 && ctx.candidates.length > 1 && !picked.some(p => p.tier === 'A')) {
      outer: for (const animeTitle of titles.slice(0, 2)) {
        for (const n of ctx.candidates.slice(1)) {
          absorb(await fetchRssItems(`${animeTitle} ${pad2(n)}`), animeTitle);
          picked = select();
          if (picked.some(p => p.tier === 'A')) break outer;
        }
      }
    }

    const results: SourceResult[] = [];
    const tierOf = new Map<SourceResult, string>();
    for (const { item: r, tier, hit } of picked) {
      const magnetLink = r.infoHash ? buildMagnet(r.infoHash, r.torrentTitle) : '';
      const url = magnetLink || r.torrentUrl;
      if (!url) continue;
      const releaseGroup = r.torrentTitle.match(/^\[([^\]]{1,40})\]/)?.[1];
      const score = tier === 'C'
        ? Math.round(scoreTitleMatch(r.torrentTitle, r.animeTitle) * 0.3)
        : scoreTorrentResult(r.torrentTitle, r.animeTitle, hit ?? ep, r.seeders);
      results.push({
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
      });
      tierOf.set(results[results.length - 1], tier);
    }

    // Sort: tier (kept by selectByTier), then matchScore desc, then peers desc
    results.sort((a, b) => {
      const t = (tierOf.get(a) ?? 'C').localeCompare(tierOf.get(b) ?? 'C');
      if (t !== 0) return t;
      const ms = (b.matchScore ?? 0) - (a.matchScore ?? 0);
      if (ms !== 0) return ms;
      return (b.peers ?? 0) - (a.peers ?? 0);
    });

    return results.slice(0, 50);
  },
};

export default provider;
