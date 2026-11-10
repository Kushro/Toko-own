/**
 * Nyaa torrent provider — magnet links, episode filtering + scoring.
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import {
  isBatchTitle,
  scoreTorrentResult,
  buildMagnet,
  parseEpisodeFromTitle,
} from '../../utils/torrent/matcher.js';
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

const provider: TorrentProvider = {
  name: 'nyaa',
  sites: BASES,
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    // "... Part 2" is searched as the bare title plus SxxEyy; the season filter below keeps other seasons out.
    const season = seasonOf(opts.titles ?? []);
    const titles = searchTitles((opts.titles ?? []).map(stripSeason));
    const ep = opts.episode ?? 0;
    if (titles.length === 0) return [];

    // Per title: episode-specific queries first, then the broad one. Each result is scored against the title that
    // found it.
    const epPad3 = ep > 0 ? String(ep).padStart(3, '0') : '';
    const epPad2 = ep > 0 ? String(ep).padStart(2, '0') : '';
    const ss = season ? String(season).padStart(2, '0') : '';
    const plan = titles.flatMap(animeTitle => (ep > 0
      ? (season && season > 1
        ? [`${animeTitle} S${ss}E${epPad2}`, `${animeTitle} S${season} - ${epPad2}`, `${animeTitle} - ${epPad2}`, animeTitle]
        : [`${animeTitle} - ${epPad2}`, `${animeTitle} ${epPad2}`, `${animeTitle} - ${epPad3}`, animeTitle])
      : [animeTitle]).map(query => ({ animeTitle, query })));

    const seen = new Set<string>();
    const results: SourceResult[] = [];

    for (const { animeTitle, query } of plan) {
      // Up to 50: a weekly episode easily has 25+ releases (groups x 480p/720p/1080p); 20 cut most of them.
      if (results.length >= 50) break;
      const items = await fetchRssItems(query);

      for (const item of items) {
        // Extract torrent download URL
        const torrentUrl =
          item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ??
          item.match(/<link>\s*(https?:\/\/[^<]+)\s*<\/link>/)?.[1] ??
          '';

        const torrentTitle =
          item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
          item.match(/<title>(.*?)<\/title>/)?.[1] ??
          '';

        if (!torrentTitle) continue;
        if (seen.has(torrentTitle)) continue;

        // Skip batch packs when targeting a specific episode
        if (ep > 0 && isBatchTitle(torrentTitle)) continue;

        // Build magnet from nyaa:infoHash if present, else from torrent URL
        const infoHashRaw =
          item.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/)?.[1] ??
          torrentUrl.match(/download\/([a-f0-9]{40})/i)?.[1] ??
          '';

        let magnetLink = '';
        if (infoHashRaw) {
          magnetLink = buildMagnet(infoHashRaw, torrentTitle);
        }

        const seeders = parseInt(item.match(/<nyaa:seeders>(.*?)<\/nyaa:seeders>/)?.[1] ?? '0', 10);
        const leechers = parseInt(item.match(/<nyaa:leechers>(.*?)<\/nyaa:leechers>/)?.[1] ?? '0', 10);
        const fileSize = item.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] ?? '';

        // Score this result
        const matchScore = scoreTorrentResult(torrentTitle, animeTitle, ep, seeders);
        if (ep > 0 && matchScore === 0) continue; // skip irrelevant results
        // Another season said explicitly: out. For a later season the release must say so ("S02E03", "S2 - 03",
        // "2nd Season"): an unmarked "Title - 03" is season 1 episode 3 under the same bare title.
        if (ep > 0 && seasonMismatch(torrentTitle, season)) continue;
        if (ep > 0 && season && season > 1 && releaseSeason(torrentTitle) === null) continue;

        seen.add(torrentTitle);

        // url = magnet if available, else .torrent URL
        const url = magnetLink || torrentUrl;
        if (!url) continue;

        const parsed = parseEpisodeFromTitle(torrentTitle);
        const releaseGroupMatch = torrentTitle.match(/^\[([^\]]{1,40})\]/);
        const releaseGroup = releaseGroupMatch?.[1];

        results.push({
          source: 'nyaa',
          url,
          quality: normalizeQuality(torrentTitle),
          headers: {},
          subtitles: [],
          sourceType: 'torrent' as const,
          audioLanguage: 'ja',
          torrentTitle,
          magnetLink: magnetLink || undefined,
          seeders,
          leechers,
          peers: seeders + leechers,
          fileSize,
          matchScore,
          releaseGroup,
        });
      }
    }

    // Sort: matchScore desc, then peers desc
    results.sort((a, b) => {
      const ms = (b.matchScore ?? 0) - (a.matchScore ?? 0);
      if (ms !== 0) return ms;
      return (b.peers ?? 0) - (a.peers ?? 0);
    });

    return results.slice(0, 50);
  },
};

export default provider;
