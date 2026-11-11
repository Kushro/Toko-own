/**
 * What AniList knows about a show that a release name does not say: the next episode due to air, the start year,
 * and the prequel chain with each entry's episode count.
 *
 * Two torrent problems hang on it:
 *   - AniList splits a long show into one entry per cour, while release groups keep numbering across the arc.
 *     "BLEACH: TYBW - The Calamity" episode 1 is episode 41 on nyaa. Summing the prequel chain's episode counts
 *     gives the numbers a group may have used ([episodeCandidates]).
 *   - An episode that has not aired yet still "matches" a years-old file of an earlier cour that reused its number
 *     ([episodeNotAired]).
 *
 * A failed lookup is never cached, so a rate-limited answer does not disable both checks for the whole session.
 */
import { fetchResponse } from '../http/fetch.js';
import { significantTokens } from './tokens.js';

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

export interface PrequelEntry {
  episodes: number;
  /** Significant words of the entry's romaji + english titles. */
  tokens: Set<string>;
}

export interface ShowFacts {
  /** Next episode due to air (running or not yet premiered), or null. */
  nextAiring: number | null;
  startYear: number | null;
  format: string | null;
  /** Nearest prequel first. */
  prequels: PrequelEntry[];
}

interface RelationNode {
  id: number;
  episodes?: number | null;
  format?: string | null;
  title?: { romaji?: string | null; english?: string | null } | null;
  relations?: { edges?: Array<{ relationType?: string; node?: RelationNode | null }> } | null;
}

interface MediaNode extends RelationNode {
  status?: string | null;
  startDate?: { year?: number | null } | null;
  nextAiringEpisode?: { episode?: number | null } | null;
}

const NODE = 'id episodes format title{romaji english}';
function nested(depth: number): string {
  let inner = NODE;
  for (let i = 0; i < depth; i++) inner = `${NODE} relations{edges{relationType node{${inner}}}}`;
  return inner;
}
// One nested request covers the first hops; AniList stops filling relations past ~2 levels, so a longer chain
// continues hop by hop from where it ran out.
const CHAIN_QUERY = `query($id:Int){Media(id:$id){${NODE} status startDate{year} nextAiringEpisode{episode} relations{edges{relationType node{${nested(2)}}}}}}`;
const STEP_QUERY = `query($id:Int){Media(id:$id){${NODE} relations{edges{relationType node{${NODE}}}}}}`;

/** `undefined` = the lookup failed (do not cache); `null` = AniList has no such entry. */
async function anilist(query: string, id: number): Promise<MediaNode | null | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchResponse(ANILIST_GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: 'https://anilist.co/' },
        body: JSON.stringify({ query, variables: { id } }),
        timeoutMs: 8000,
      });
      // No Retry-After and a ~1 minute window: retrying inside one search only spends more of the budget.
      if (res.status === 429) return undefined;
      if (!res.ok) continue;
      const json = JSON.parse(await res.text()) as { data?: { Media?: MediaNode | null }; errors?: unknown };
      if (json.errors && !json.data) return undefined;
      return json.data?.Media ?? null;
    } catch {
      continue;
    }
  }
  return undefined;
}

const SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

function prequelOf(node: RelationNode | null | undefined): RelationNode | null {
  const edges = node?.relations?.edges ?? [];
  return edges
    .filter(e => e.relationType === 'PREQUEL' && e.node && SERIES_FORMATS.has(e.node.format ?? ''))
    .map(e => e.node as RelationNode)
    .sort((a, b) => (b.episodes ?? 0) - (a.episodes ?? 0))[0] ?? null;
}

function entryOf(node: RelationNode): PrequelEntry {
  const tokens = new Set<string>();
  for (const t of [node.title?.romaji, node.title?.english]) for (const tok of significantTokens(t ?? '')) tokens.add(tok);
  return { episodes: node.episodes ?? 0, tokens };
}

async function fetchFacts(anilistId: number): Promise<ShowFacts | undefined> {
  const root = await anilist(CHAIN_QUERY, anilistId);
  if (root === undefined) return undefined;
  if (root === null) return { nextAiring: null, startYear: null, format: null, prequels: [] };

  const next = Number(root.nextAiringEpisode?.episode);
  const facts: ShowFacts = {
    nextAiring: Number.isInteger(next) && next > 0 ? next : null,
    startYear: Number.isInteger(root.startDate?.year) ? root.startDate!.year! : null,
    format: root.format ?? null,
    prequels: [],
  };

  const seen = new Set<number>([anilistId]);
  let node: RelationNode | null = root;
  let lastId = anilistId;
  let needsStep = false;
  while (facts.prequels.length < 12) {
    const p = prequelOf(node);
    if (!p) {
      // Past ~2 levels AniList answers an empty edge list rather than leaving it out; that is "not filled in",
      // not "no prequel", so ask that entry on its own.
      if (node !== root && !(node?.relations?.edges?.length)) needsStep = true;
      break;
    }
    if (!p.episodes || seen.has(p.id)) break;
    facts.prequels.push(entryOf(p));
    seen.add(p.id);
    lastId = p.id;
    if (p.relations == null) { needsStep = true; break; }
    node = p;
  }
  // Continue hop by hop where the nested request ran out of depth.
  for (let depth = 0; needsStep && depth < 12 && facts.prequels.length < 12; depth++) {
    const media = await anilist(STEP_QUERY, lastId);
    if (media === undefined) return undefined;
    const p = prequelOf(media);
    if (!p || !p.episodes || seen.has(p.id)) break;
    facts.prequels.push(entryOf(p));
    seen.add(p.id);
    lastId = p.id;
  }
  return facts;
}

const cache = new Map<number, ShowFacts>();
const inflight = new Map<number, Promise<ShowFacts | null>>();

/** Facts for an AniList id, or null when the lookup failed. Never throws. */
export async function getShowFacts(anilistId: number | undefined): Promise<ShowFacts | null> {
  if (!anilistId || !Number.isFinite(anilistId) || anilistId <= 0) return null;
  const hit = cache.get(anilistId);
  if (hit) return hit;
  const running = inflight.get(anilistId);
  if (running) return running;
  const task = fetchFacts(anilistId)
    .then(f => {
      if (!f) return null;
      if (cache.size > 300) cache.clear();
      cache.set(anilistId, f);
      return f;
    })
    .catch(() => null)
    .finally(() => inflight.delete(anilistId));
  inflight.set(anilistId, task);
  return task;
}

/** A prequel belongs to the same titled run when it shares at least half of the show's words. */
function sharesRun(showTokens: Set<string>, prequel: Set<string>): boolean {
  if (!showTokens.size || !prequel.size) return true;
  let shared = 0;
  for (const t of prequel) if (showTokens.has(t)) shared++;
  return shared / showTokens.size >= 0.5;
}

/**
 * Episode numbers a release group may have used for `episode`, the AniList number first.
 *
 * Groups number continuously from the start of a titled run, so only the total of a complete run is a real
 * convention: a partial sum through the middle of one points at an episode that exists but is not this one
 * (The Calamity episode 7 was matching episode 34, episode 7 of the previous cour). Sums under 10 are ignored.
 */
export function episodeCandidates(facts: ShowFacts | null, episode: number, showTokens: Set<string>): number[] {
  const out = [episode];
  if (!facts || !(episode > 0)) return out;
  let running = 0;
  for (const p of facts.prequels) {
    if (!p.episodes) continue;
    if (!sharesRun(showTokens, p.tokens) && running >= 10 && !out.includes(episode + running)) out.push(episode + running);
    running += p.episodes;
  }
  if (running >= 10 && !out.includes(episode + running)) out.push(episode + running);
  return out;
}

/** True when AniList says `episode` is not out yet (at or past the next one due). */
export function episodeNotAired(facts: ShowFacts | null, episode: number): boolean {
  return !!facts && facts.nextAiring !== null && episode >= facts.nextAiring;
}
