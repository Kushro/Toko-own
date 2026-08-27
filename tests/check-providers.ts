/**
 * Provider health check harness.
 *
 * Runs every STREAM_PROVIDERS entry against a real query and reports which
 * produce usable results, what kind of results (hls/mp4/embed), and which fail.
 *
 * Usage: npx tsx tests/check-providers.ts [anilistId] [episode] [title...]
 */
import type { SourceOptions, SourceResult } from '../src/types.js';
import { STREAM_PROVIDERS } from '../src/providers/registry.js';

const anilistId = parseInt(process.argv[2] || '21', 10); // 21 = One Piece
const episode = parseInt(process.argv[3] || '1', 10);
const titles = process.argv.slice(4).length ? process.argv.slice(4) : ['One Piece'];

interface Row {
  name: string;
  status: 'ok' | 'empty' | 'error' | 'timeout';
  ms: number;
  count: number;
  kinds: string;
  sample: string;
  error?: string;
}

function classify(url: string): string {
  if (/\.m3u8($|[?#])/i.test(url)) return 'hls';
  if (/\.mp4($|[?#])/i.test(url)) return 'mp4';
  const t = /sourceType['"]?\s*[:=]\s*['"](\w+)/.exec(url)?.[1];
  return t || 'other';
}

function kindsOf(results: SourceResult[]): string {
  const kinds = new Set<string>();
  for (const r of results) {
    if (r.sourceType) kinds.add(r.sourceType);
    else kinds.add(classify(r.url));
  }
  return [...kinds].join('+') || '-';
}

async function testProvider(name: string, p: any, timeoutMs: number): Promise<Row> {
  const opts: SourceOptions = {
    anilistId,
    titles,
    episode,
    episodeCount: 12,
    resolution: '1080p',
    providerOptions: { timeoutMs: Math.min(timeoutMs, 12000) },
  };
  const start = Date.now();
  try {
    const fn = p.single || p.batch;
    if (!fn) return { name, status: 'error', ms: 0, count: 0, kinds: '-', sample: '-', error: 'no single/batch' };
    const results: SourceResult[] = await Promise.race([
      fn.call(p, opts),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('harness timeout')), timeoutMs)),
    ]);
    const ms = Date.now() - start;
    const sample = results[0]?.url ? String(results[0].url).slice(0, 90) : '-';
    return {
      name,
      status: results.length > 0 ? 'ok' : 'empty',
      ms,
      count: results.length,
      kinds: kindsOf(results),
      sample,
    };
  } catch (err: any) {
    const ms = Date.now() - start;
    const msg = String(err?.message || err);
    return { name, status: msg.includes('harness timeout') ? 'timeout' : 'error', ms, count: 0, kinds: '-', sample: '-', error: msg.slice(0, 100) };
  }
}

async function main() {
  const timeoutMs = 45000;
  console.log(`Testing ${STREAM_PROVIDERS.length} stream providers for "${titles[0]}" ep ${episode} (anilist ${anilistId})\n`);

  const rows: Row[] = [];
  const CONCURRENCY = 6;
  const queue = [...STREAM_PROVIDERS];

  async function worker() {
    while (queue.length) {
      const p = queue.shift()!;
      process.stderr.write(`  → testing ${p.name}...\n`);
      rows.push(await testProvider(p.name, p, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  rows.sort((a, b) => a.name.localeCompare(b.name));

  console.log('\n=== RESULTS ===');
  console.log('PROVIDER        STATUS   TIME     COUNT  KINDS      SAMPLE / ERROR');
  console.log('-'.repeat(120));
  for (const r of rows) {
    const detail = r.error || r.sample;
    console.log(
      `${r.name.padEnd(15)} ${r.status.padEnd(8)} ${String(r.ms + 'ms').padEnd(8)} ${String(r.count).padEnd(6)} ${r.kinds.padEnd(10)} ${detail}`,
    );
  }

  const ok = rows.filter((r) => r.status === 'ok');
  const bad = rows.filter((r) => r.status !== 'ok');
  console.log(`\n${ok.length} OK / ${bad.length} failing`);
  console.log('Failing: ' + bad.map((r) => `${r.name}(${r.status})`).join(', '));

  // Verify playable URLs actually return video data
  console.log('\n=== URL VERIFICATION (first result of each OK provider) ===');
  for (const r of ok) {
    const p = STREAM_PROVIDERS.find((x) => x.name === r.name)!;
    const opts: SourceOptions = { anilistId, titles, episode, resolution: '1080p' };
    try {
      const results = await (p.single || p.batch).call(p, opts);
      const direct = results.find((x) => x.sourceType === 'hls' || x.sourceType === 'mp4' || /\.(m3u8|mp4)($|[?#])/i.test(x.url));
      if (!direct) {
        console.log(`${r.name.padEnd(15)} embed-only (${results[0]?.url?.slice(0, 70)})`);
        continue;
      }
      const res = await fetch(direct.url, {
        headers: direct.headers as any,
        signal: AbortSignal.timeout(15000),
      }).catch((e) => null);
      if (!res) { console.log(`${r.name.padEnd(15)} FETCH FAILED ${direct.url.slice(0, 60)}`); continue; }
      const ct = res.headers.get('content-type') || '';
      const len = res.headers.get('content-length');
      const buf = res.body ? (await res.arrayBuffer()).byteLength : 0;
      const text = buf > 0 && buf < 100000 ? Buffer.from(await (res.body ? new Response(res.body).arrayBuffer() : new ArrayBuffer(0))).toString().slice(0, 40).replace(/\n/g, ' ') : '';
      console.log(`${r.name.padEnd(15)} HTTP ${res.status} ${ct.slice(0, 30).padEnd(30)} len=${len ?? buf} ${text ? '| ' + text : ''} | ${direct.url.slice(0, 55)}`);
    } catch (e: any) {
      console.log(`${r.name.padEnd(15)} VERIFY ERROR ${String(e?.message).slice(0, 60)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
