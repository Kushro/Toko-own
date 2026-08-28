/**
 * Offline smoke tests for the round-2 changes (torrent audit + WAW restore).
 *
 * Run: npx tsx tests/smoke-round2.test.ts
 */

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const routes = new Map<RegExp, Handler>();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

(globalThis as any).fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  for (const [re, handler] of routes) {
    if (re.test(url)) return handler(url, init);
  }
  throw new Error(`smoke test: no route for ${url}`);
};

// ── Registry ────────────────────────────────────────────────────────────────
async function testRegistry(): Promise<void> {
  console.log('\nregistry');
  const { STREAM_PROVIDERS, TORRENT_PROVIDERS } = await import('../src/providers/registry.js');
  const streams = STREAM_PROVIDERS.map((p) => p.name);
  const torrents = TORRENT_PROVIDERS.map((p) => p.name);

  check('16 stream providers', STREAM_PROVIDERS.length === 16, `got ${STREAM_PROVIDERS.length}: ${streams.join(', ')}`);
  check('6 torrent providers', TORRENT_PROVIDERS.length === 6, `got ${TORRENT_PROVIDERS.length}: ${torrents.join(', ')}`);
  check('acgrip removed', !torrents.includes('acgrip'));
  check('watchanimeworld restored', streams.includes('watchanimeworld'));
  check('moviebox still present', streams.includes('moviebox'));
  check('torrent core intact', ['nyaa', 'animetosho', 'subplease', 'seadex', 'nekobt', 'aniliberty'].every((n) => torrents.includes(n)));
}

// ── watchanimeworld ─────────────────────────────────────────────────────────
function b64url(payload: string): string {
  return encodeURIComponent(Buffer.from(payload).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
}

async function testWatchAnimeWorld(): Promise<void> {
  console.log('\nwatchanimeworld (.one restore)');

  // Server list as WAW's player1.php ships it (URL-safe base64 JSON)
  const servers = [
    { link: 'https://cdn.waw.one/hindi/ep1/master.m3u8', language: 'Hindi', quality: '1080p' },
    { link: 'https://cdn.waw.one/tamil/ep1/index.m3u8', language: 'Tamil', quality: '720p' },
    { link: 'https://cdn.waw.one/japan/ep1/video.mp4', language: 'Japanese', quality: '1080p' },
  ];
  const dataParam = b64url(JSON.stringify(servers));

  const episodeHtml = `
    <html><head><title>WAW</title></head><body>
      <div id="player"><iframe src="https://watchanimeworld.one/api/player1.php?data=${dataParam}"></iframe></div>
      <iframe src="https://play.zephyrflick.top/wrapper"></iframe>
      <iframe src="https://googletagmanager.com/x"></iframe>
    </body></html>`;

  const challengeHtml = `<html><head><title>Attention Required! | Cloudflare</title></head>
    <body>Sorry, you have been blocked. Cloudflare Ray ID: abc123</body></html>`;

  routes.set(/^https:\/\/watchanimeworld\.one\/episode\/one-piece-1x1\//, (_url, init) => {
    // Simulate the CF gate: challenge unless the browser UA carries clearance
    const ua = new Headers(init?.headers).get('user-agent') ?? '';
    return new Response(ua.includes('Chrome') ? episodeHtml : challengeHtml, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  const mod = await import('../src/providers/stream/watchanimeworld.js');
  const provider = mod.default;

  const results = await provider.single({
    anilistId: 21,
    titles: ['One Piece'],
    episode: 1,
    resolution: '1080p',
  });

  check('extracts player1 server list', results.length >= 3, `got ${results.length}`);
  check('hindi dub mapped', results.some((r) => r.audioLanguage === 'hi'));
  check('tamil dub mapped', results.some((r) => r.audioLanguage === 'ta'));
  check('hls detected', results.filter((r) => r.audioLanguage !== 'ja').every((r) => r.sourceType === 'hls'));
  check('mp4 detected', results.some((r) => r.sourceType === 'mp4' && r.audioLanguage === 'ja'));
  check('playback referer is the watch page', (results[0]?.headers?.Referer ?? '').includes('/episode/one-piece-1x1'));

  // decodePlayer1Payload unit check
  const decoded = JSON.parse(mod.decodePlayer1Payload(dataParam));
  check('decodePlayer1Payload round-trips', Array.isArray(decoded) && decoded.length === 3);

  // A page whose only iframes are the zephyr wrapper + analytics must yield
  // zero sources — those hosts are never playable.
  routes.set(/^https:\/\/watchanimeworld\.one\/episode\/wrapper-test-1x1\//, () =>
    new Response(
      `<html><body>
        <iframe src="https://play.zephyrflick.top/wrapper"></iframe>
        <iframe src="https://googletagmanager.com/x"></iframe>
        <iframe src="https://www.recaptcha.net/recaptcha/x"></iframe>
      </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    ));
  const filtered = await provider.single({
    anilistId: 999,
    titles: ['Wrapper Test'],
    episode: 1,
    resolution: '1080p',
  });
  check('zephyr wrapper + analytics iframes filtered out', filtered.length === 0, JSON.stringify(filtered.map((r) => r.url)));
}

// ── toonstream ───────────────────────────────────────────────────────────────
async function testToonStream(): Promise<void> {
  console.log('\ntoonstream (JSON discovery + embed wrapper)');

  const episodeHtml = `
    <aside id="aa-options">
      <div id="options-0" class="video aa-tb">
        <iframe data-src="/embed/test-wrapper"></iframe>
      </div>
    </aside>
    <aside class="video-options">
      <ul class="aa-tbs aa-tbs-video">
        <li><a href="#options-0"><span class="server">Ruby</span></a></li>
      </ul>
    </aside>${' '.repeat(220)}`;
  const seriesHtml = `<html><body><a href="/episode/one-piece-1x6/">Episode 6</a>${' '.repeat(220)}</body></html>`;
  const wrapperHtml = `<html><body><div class="Video"><iframe src="https://rubystm.com/e/example.html"></iframe></div>${' '.repeat(220)}</body></html>`;

  // The direct slug (`one-piece`) is intentionally unavailable. Discovery
  // must use the site's JSON search endpoint, then match the episode slug
  // independently from the series slug.
  routes.set(/^https:\/\/toon-stream\.site\/series\/one-piece$/, () =>
    new Response('not found', { status: 404 }));
  routes.set(/^https:\/\/toon-stream\.site\/search\/all\?q=/, () =>
    jsonResponse({
      count: 1,
      data: [{ title: 'One Piece', type: 'series', url: '/series/one-piece-dub-sub' }],
    }));
  routes.set(/^https:\/\/toon-stream\.site\/series\/one-piece-dub-sub$/, () =>
    new Response(seriesHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }));
  routes.set(/^https:\/\/toon-stream\.site\/episode\/one-piece-1x6\/$/, () =>
    new Response(episodeHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }));
  routes.set(/^https:\/\/toon-stream\.site\/embed\/test-wrapper$/, () =>
    new Response(wrapperHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }));

  const mod = await import('../src/providers/stream/toonstream.js');
  const provider = mod.default;
  const results = await provider.single({
    anilistId: 21,
    titles: ['One Piece'],
    episode: 6,
    resolution: '1080p',
  });

  check('JSON search discovers series', results.length >= 1, `got ${results.length}`);
  check('episode slug can differ from series slug', results.some((r) => r.url.includes('rubystm.com/e/example.html')));
  check('wrapper fallback has a usable URL', results.every((r) => /^https?:\/\/\S+$/.test(r.url)));
}

// ── aniliberty ──────────────────────────────────────────────────────────────
async function testAniliberty(): Promise<void> {
  console.log('\naniliberty (JSON API rewrite)');

  routes.set(/\/api\/v1\/app\/search\/releases/, (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('query') ?? '');
    if (q.toLowerCase().includes('frieren')) {
      return jsonResponse([
        { id: 9542, name: { main: 'Провожающая в последний путь Фрирен', english: 'Sousou no Frieren' } },
      ]);
    }
    return jsonResponse([]);
  });
  routes.set(/\/api\/v1\/anime\/torrents\/release\/9542/, () =>
    jsonResponse([
      {
        id: 28083,
        filename: 'Sousou no Frieren - AniLiberty.TOP [WEBRip 1080p][HEVC][1-28].torrent',
        magnet: 'magnet:?xt=urn:btih:2f8f88eb64310eb6c72a2193a068514428583927&tr=http://tr.libria.fun:2710/announce',
        size: 8314190487,
        seeders: 131,
        leechers: 4,
      },
      {
        id: 28084,
        filename: 'Sousou no Frieren - AniLiberty.TOP [WEBRip 1080p][AVC][07].torrent',
        magnet: 'magnet:?xt=urn:btih:046080624672f569188f7613b915d3222d0a0fcd&tr=http://tr.libria.fun:2710/announce',
        size: 731419048,
        seeders: 49,
        leechers: 1,
      },
    ]));

  const mod = await import('../src/providers/torrent/aniliberty.js');
  const provider = mod.default;

  const results = await provider.batch({
    anilistId: 0,
    titles: ['Sousou no Frieren'],
    episode: 7,
    resolution: '1080p',
  });

  check('returns torrents', results.length >= 1, `got ${results.length}`);
  check('episode filter keeps ep-7 release', results.some((r) => r.torrentTitle?.includes('[07]')));
  check('batch release kept', results.some((r) => r.torrentTitle?.includes('1-28')));
  check('magnet link set', results.every((r) => r.magnetLink?.startsWith('magnet:')));
  check('seeders parsed', results.find((r) => r.torrentTitle?.includes('[07]'))?.seeders === 49);
  check('file sizes humanized', results.some((r) => r.fileSize === '8.3 GB') && results.some((r) => r.fileSize === '731 MB'), results.map((r) => r.fileSize).join(','));
  check('russian dub tagged', results.every((r) => r.audioLanguage === 'ru'));
  check('mkv format inferred', results.every((r) => r.fileFormat === 'mkv' || r.fileFormat === 'video'));

  // No bogus query → no results, no crash
  const none = await provider.batch({ anilistId: 0, titles: ['Nonexistent Show'], episode: 1, resolution: '1080p' });
  check('unknown title returns empty', none.length === 0);
}

async function main(): Promise<void> {
  await testRegistry();
  await testWatchAnimeWorld();
  await testToonStream();
  await testAniliberty();
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
