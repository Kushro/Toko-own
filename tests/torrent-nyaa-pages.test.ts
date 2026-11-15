import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import nyaa, { pageCutsEpisode, type RawRelease } from '../src/providers/torrent/nyaa';
import { buildTierContext } from '../src/utils/torrent/tiers';

// Real nyaa feeds (2026-11-14) for every query the provider makes for Magical Explorer 05 / 06 and Overgeared 04,
// plus the AniList answers its tier context reads. Page 1 of "Magical Explorer" ends inside the ep. 05/06 release
// wave: Judas, Erai-raws, ASW and SubsPlease are only on page 2 and in the numbered queries.
interface FixtureItem { title: string; pubDate?: string; infoHash?: string; seeders: number }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/nyaa-magical-explorer-overgeared.json', import.meta.url), 'utf8')) as {
  nyaa: Record<string, FixtureItem[]>;
  anilist: Record<string, unknown>;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rss = (items: FixtureItem[]) => `<?xml version="1.0"?><rss><channel>${items.map(i =>
  `<item><title>${esc(i.title)}</title><pubDate>${i.pubDate ?? ''}</pubDate>` +
  `<nyaa:seeders>${i.seeders}</nyaa:seeders><nyaa:infoHash>${i.infoHash ?? ''}</nyaa:infoHash></item>`).join('')}</channel></rss>`;

const queries: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('anilist')) {
      const id = JSON.parse(String(init?.body)).variables.id;
      return new Response(JSON.stringify(fixture.anilist[id] ?? { data: { Media: null } }), { status: 200 });
    }
    const q = new URL(url).searchParams.get('q') ?? '';
    queries.push(q);
    return new Response(rss(fixture.nyaa[q] ?? []), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

const ME = ['Magical★Explorer: Eroge no Yuujin Chara ni Tensei Shitakedo, Game Chishiki Tsukatte Jiyuu ni Ikiru', 'Magical Explorer',
  'マジカル★エクスプローラー　エロゲの友人キャラに転生したけど、ゲーム知識使って自由に生きる', 'Magical Explorer: Reborn as a Side Character in a Fantasy Dating Sim', 'Majieku'];
const OG = ['Tempal: Item no Chikara', 'Overgeared', 'テムパル～アイテムの力～', '템빨', 'Temppal', 'Tempal - Item no Chikara'];

async function run(anilistId: number, titles: string[], episode: number) {
  queries.length = 0;
  const results = await nyaa.batch({ anilistId, titles, episode } as never);
  return { titles: results.map(r => r.torrentTitle ?? ''), queries: [...queries] };
}
const hasGroup = (titles: string[], group: string) => titles.some(t => t.startsWith(`[${group}]`));

test('Magical Explorer 05: a first page cut inside the episode is completed by the numbered queries', async () => {
  const { titles, queries } = await run(169581, ME, 5);
  for (const g of ['ASW', 'Erai-raws', 'Judas', 'SubsPlease', 'ToonsHub', 'AnoZu', 'Yameii']) expect(hasGroup(titles, g)).toBe(true);
  expect(titles.filter(t => t.startsWith('[Erai-raws]')).length).toBe(4);
  expect(queries).toContain('Magical Explorer - 05');
  expect(queries).toContain('Magical Explorer S01E05');
  expect(queries.length).toBe(5);
  // Every result is episode 5.
  expect(titles.every(t => /(?:- 0?5\b|E05\b)/.test(t))).toBe(true);
});

test('Magical Explorer 06 (same day as 05) keeps ASW and gains the groups past page 1', async () => {
  const { titles } = await run(169581, ME, 6);
  for (const g of ['ASW', 'Erai-raws', 'Judas', 'SubsPlease']) expect(hasGroup(titles, g)).toBe(true);
  expect(titles.filter(t => t.startsWith('[Erai-raws]')).length).toBe(4);
  expect(titles.every(t => /(?:- 0?6\b|E06\b)/.test(t))).toBe(true);
});

test('Overgeared 04 lists the groups that use the romaji title', async () => {
  const { titles } = await run(212888, OG, 4);
  for (const g of ['ASW', 'Erai-raws', 'Judas', 'SubsPlease', 'ToonsHub']) expect(hasGroup(titles, g)).toBe(true);
  expect(titles.every(t => /(?:- 0?4\b|E04\b)/.test(t))).toBe(true);
});

const rel = (title: string, hoursAgo: number): RawRelease => ({
  animeTitle: 'Some Show', torrentTitle: title, torrentUrl: '', infoHash: '', seeders: 1, leechers: 0, fileSize: '',
  publishedAt: Date.UTC(2026, 10, 14) - hoursAgo * 3600_000, trusted: false, remake: false,
});

test('a page is cut only when it ends inside the episode release wave', async () => {
  const ctx = await buildTierContext({ titles: ['Some Show'], episode: 5 }, null);
  const filler = (from: number, n: number, ep: number) => Array.from({ length: n }, (_, i) => rel(`[G${i}] Some Show - ${String(ep).padStart(2, '0')} [1080p]`, from + i));
  // Episode 5 uploaded 10-20 h before the page's end: cut.
  expect(pageCutsEpisode([...filler(0, 60, 7), ...filler(100, 15, 5)], ctx, 5)).toBe(true);
  // The page reaches a week past episode 5's oldest upload: the wave is all there.
  expect(pageCutsEpisode([...filler(0, 40, 7), ...filler(100, 15, 5), ...filler(268, 20, 4)], ctx, 5)).toBe(false);
  // A late re-upload of episode 4 among the newer items does not mean the page reached past episode 5.
  expect(pageCutsEpisode([...filler(0, 59, 7), rel('[Late] Some Show - 04 [1080p]', 50), ...filler(100, 15, 5)], ctx, 5)).toBe(true);
  // No episode 5 on the page: the regular "nothing exact" path handles it.
  expect(pageCutsEpisode(filler(0, 75, 7), ctx, 5)).toBe(false);
  // Unknown dates: assume cut.
  expect(pageCutsEpisode(filler(0, 75, 5).map(r => ({ ...r, publishedAt: 0 })), ctx, 5)).toBe(true);
});
