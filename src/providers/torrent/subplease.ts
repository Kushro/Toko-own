/**
 * SubsPlease torrent provider — episode-filtered with peer data.
 * SubsPlease API: https://subsplease.org/api/?f=search&tz=UTC&s=<title>
 * Key format: each key is a release file name like "One Piece - 001 (1080p)..."
 * Requirements: 4.1, 4.3
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import { scoreEpisodeMatch, isBatchTitle } from '../../utils/torrent/matcher.js';
import { buildTierContext } from '../../utils/torrent/tiers.js';
import { firstWithResults, seasonOf, seasonMismatch, releaseSeason, stripSeason } from '../../utils/torrent/search-titles.js';

interface SubPleaseDownload {
  res: string;
  magnet: string;
}

interface SubPleaseShow {
  show: string;
  /** RFC 2822, e.g. "Fri, 29 May 2026 17:05:35 +0000". */
  release_date?: string;
  episode: string;
  downloads: SubPleaseDownload[];
}

interface SubPleaseResponse {
  [key: string]: SubPleaseShow;
}

/** Parse episode number from a SubsPlease key like "One Piece - 001 (1080p) [...]" */
function parseEpisodeNumber(key: string): number | null {
  // SubsPlease keys: "Title - 001v2 (1080p) [hash]" or "Title - 001 (720p)"
  const m = key.match(/- (\d+)(?:v\d+)?\s*\(/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Check if title looks like a batch pack */
function isBatch(key: string): boolean {
  // Delegate to the shared detector: it guards the episode-range test (needs a
  // 5+ span) so a digit-suffixed show title like "86 - 11" is not misread as a
  // "11-episode batch" and dropped.
  return isBatchTitle(key);
}

/** Normalize title for matching by removing extra spaces, brackets, version tags */
function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[[\](){}]/g, '')
    .replace(/\bv\d+\b/g, '')
    .trim();
}

const BASE = 'https://subsplease.org';

const provider: TorrentProvider = {
  name: 'subplease',
  sites: [BASE],
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    // Each short title in turn (the first one may be a long romaji that finds nothing).
    return firstWithResults((opts.titles ?? []).map(stripSeason), title => searchOne(opts, title));
  },
};

/** A SubsPlease API response, or null when it is empty, not JSON or has no releases. */
async function fetchFeed(url: string): Promise<SubPleaseResponse | null> {
  try {
    const res = await fetchResponse(url, { signal: AbortSignal.timeout(10000) } as RequestInit);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text.startsWith('{')) return null;
    const data = JSON.parse(text) as SubPleaseResponse;
    return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0 ? data : null;
  } catch {
    return null;
  }
}

async function searchOne(opts: SourceOptions, title: string): Promise<SourceResult[]> {
  {
    const ep = opts.episode ?? 0;
    if (!title) return [];

    // The search endpoint has answered HTTP 200 with an empty body for every term before; the latest feed kept
    // working, so it stands in (filtered by title below) and the currently airing shows are still found.
    const data = await fetchFeed(`${BASE}/api/?f=search&tz=UTC&s=${encodeURIComponent(title)}`)
      ?? await fetchFeed(`${BASE}/api/?f=latest&tz=UTC`);
    if (!data) return [];

    const results: SourceResult[] = [];
    const normalizedSearchTitle = normalizeTitle(title);
    const titleMatches: Array<{ key: string; show: SubPleaseShow }> = [];

    const wanted = seasonOf(opts.titles ?? []);
    for (const key of Object.keys(data)) {
      const show = data[key];
      if (!show?.downloads || !Array.isArray(show.downloads)) continue;
      if (isBatch(key)) continue;
      // A season 2 request must not take a show named for another season ("Title S3").
      if (seasonMismatch(key, wanted)) continue;

      const normalizedKeyTitle = normalizeTitle(key.split('-')[0] || '');
      const titleMatch = normalizedKeyTitle.includes(normalizedSearchTitle) || normalizedSearchTitle.includes(normalizedKeyTitle);
      if (!titleMatch) continue;

      titleMatches.push({ key, show });
    }

    // Episode numbers SubsPlease may use: the AniList one, or one counted across the arc for a cour-split show
    // ("Kusuriya no Hitorigoto - 54" is season 3 episode 6).
    const ctx = ep > 0 ? await buildTierContext({ anilistId: opts.anilistId, titles: opts.titles ?? [], episode: ep }) : null;
    const candidates = ctx?.candidates ?? [];

    // An episode AniList says has not aired: only a release of it from the last week is believed (groups beat the
    // schedule).
    if (ctx?.notAired) {
      for (let i = titleMatches.length - 1; i >= 0; i--) {
        const at = Date.parse(titleMatches[i].show.release_date ?? '');
        if (!(Number.isFinite(at) && Date.now() - at <= 7 * 24 * 60 * 60 * 1000)) titleMatches.splice(i, 1);
      }
    }

    for (const { key, show } of titleMatches) {
      if (ep > 0) {
        const epFromField = show.episode ? parseInt(show.episode, 10) : null;
        const detectedEp = epFromField ?? parseEpisodeNumber(key);

        if (detectedEp !== null) {
          if (!candidates.includes(detectedEp)) continue;
          // SubsPlease names a later season "Title S2", so an unmarked show under the AniList number is season 1.
          // A number counted across the arc names no season and is still this one.
          if (wanted && wanted > 1 && detectedEp === ep && releaseSeason(key) === null) continue;
        } else if (scoreEpisodeMatch(key, ep) === 0) {
          continue;
        }
      }

      for (const dl of show.downloads) {
        if (!dl.magnet) continue;

        results.push({
          source: 'subplease',
          url: dl.magnet,
          quality: normalizeQuality(dl.res ?? ''),
          headers: {},
          subtitles: [],
          sourceType: 'torrent' as const,
          audioLanguage: 'ja',
          torrentTitle: key,
          seeders: undefined,
          leechers: undefined,
          peers: undefined,
        });
      }
    }

    // Sort by quality: 1080p > 720p > others
    results.sort((a, b) => {
      const qa = a.quality === '1080p' ? 0 : a.quality === '720p' ? 1 : 2;
      const qb = b.quality === '1080p' ? 0 : b.quality === '720p' ? 1 : 2;
      return qa - qb;
    });

    return results.slice(0, 10);
  }
}

export default provider;
