/**
 * AnimeTosho torrent provider — with episode filtering + peer data.
 * API: https://feed.animetosho.org/json?q=<query>
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { TorrentProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
import { buildTierContext, capByTier, selectByTier, type TierInput } from '../../utils/torrent/tiers.js';
import { getAnidbIds } from '../../utils/mapping/anizip.js';
import { hitsExclusion, matchesResolution } from '../../utils/torrent/preferences.js';
import { buildSearchQueries } from '../../utils/scraping/title-normalizer.js';

interface AnimeToshoItem {
  title?: string;
  magnet_uri?: string;
  torrent_url?: string;
  seeders?: number;
  leechers?: number;
  total_size?: number;
  num_files?: number;
  info_hash?: string;
  /** Upload time, Unix seconds. */
  timestamp?: number;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

const BASE = 'https://feed.animetosho.org';

async function fetchItems(params: string): Promise<AnimeToshoItem[]> {
  try {
    const res = await fetchResponse(`${BASE}/json?${params}`, { timeoutMs: 6000 });
    if (!res.ok) return [];
    const json = await res.json() as AnimeToshoItem[];
    return Array.isArray(json) ? json : [];
  } catch { return []; }
}

const provider: TorrentProvider = {
  name: 'animetosho',
  sites: [BASE],
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    const titles = opts.titles ?? [];
    const ep = opts.episode ?? 0;
    if (titles.length === 0 && !opts.anilistId) return [];

    const [ctx, ids] = await Promise.all([
      buildTierContext({ anilistId: opts.anilistId, titles, episode: ep }),
      opts.anilistId ? getAnidbIds(opts.anilistId, ep > 0 ? ep : undefined) : Promise.resolve({ aid: null, eid: null }),
    ]);

    // AnimeTosho maps every release to AniDB, so an id lookup is this show (and with `eid`, this episode) by
    // construction, with none of the title guessing a text search needs. Text search stays as the fallback for
    // shows ani.zip has no AniDB id for, and for releases AnimeTosho has not mapped yet.
    const inputs: TierInput<AnimeToshoItem>[] = [];
    const seen = new Set<string>();
    const absorb = (items: AnimeToshoItem[], how: { exactEpisode?: boolean; knownShow?: boolean; matchTitle?: string }) => {
      for (const item of items) {
        const link = item.magnet_uri ?? item.torrent_url ?? '';
        const title = item.title ?? '';
        if (!link || !title || hitsExclusion(title, opts.exclusions)) continue;
        const key = (item.info_hash ?? link).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        inputs.push({ item, title, publishedAt: (item.timestamp ?? 0) * 1000, ...how });
      }
    };
    const hasExact = () => selectByTier(inputs, ctx).some(o => o.tier === 'A');

    if (ep > 0 && ids.eid) absorb(await fetchItems(`eid=${ids.eid}`), { exactEpisode: true, knownShow: true });
    if (ids.aid && !hasExact()) absorb(await fetchItems(`aid=${ids.aid}`), { knownShow: true });

    if (!hasExact()) {
      const epStr = ep > 0 ? ` ${String(ep).padStart(2, '0')}` : '';
      for (const title of buildSearchQueries(titles)) {
        let items: AnimeToshoItem[] = [];
        if (ep > 0) items = await fetchItems(`q=${encodeURIComponent(`${title}${epStr}`.trim())}`);
        if (items.length === 0) items = await fetchItems(`q=${encodeURIComponent(title)}`);
        absorb(items, { matchTitle: title });
        if (items.length > 0) break;
      }
    }

    // Tier first (selectByTier's order), then the requested resolution.
    const picked = selectByTier(inputs, ctx)
      .map((o, i) => ({ o, i, res: matchesResolution(o.item.title ?? '', opts.resolution) ? 0 : 1 }))
      .sort((a, b) => (a.o.tier === b.o.tier ? a.res - b.res || a.i - b.i : a.i - b.i))
      .map(x => x.o);
    const results: SourceResult[] = [];
    for (const { item, tier } of picked) {
      const torrentTitle = item.title ?? '';
      const seeders = item.seeders ?? 0;
      const leechers = item.leechers ?? 0;
      const epScore = tier === 'A' ? 100 : tier === 'B' ? 80 : 30;
      results.push({
        source: 'animetosho',
        url: item.magnet_uri ?? item.torrent_url ?? '',
        quality: normalizeQuality(torrentTitle),
        headers: {},
        subtitles: [],
        sourceType: 'torrent' as const,
        audioLanguage: 'ja',
        torrentTitle,
        seeders,
        leechers,
        peers: seeders + leechers,
        fileSize: formatSize(item.total_size),
        matchScore: capByTier(Math.round(40 + epScore * 0.5 + Math.min(10, seeders / 10)), tier),
      });
    }

    return results.slice(0, 30);
  },
};

export default provider;
