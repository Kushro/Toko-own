# Provider Health Audit — 2026-08-27

Live check of every Toko stream provider. The dev sandbox cannot reach the
streaming origins directly, so each provider's *actual upstream flow* (search
page, JSON API, watch page, player endpoint) was probed individually and its
scraper code path verified against the live markup.

## Verdicts

| Provider | Upstream | Verdict | Evidence / action |
|:--|:--|:--|:--|
| **nebula** | core.justanime.to API | ✅ working | API answers (`Origin` header-gated; provider sends it). Direct HLS/MP4. |
| **animepahe** | animepahe.pw (+6 mirrors) | ✅ working | Site banner confirms `.pw/.com/.org` are the official domains; `.pw` verified live. Reordered mirrors to lead with `.pw` (was `.ru` first). Anti-bot means failures are cheap (circuit breaker). |
| **animeya** | animeya.cc + vidnest.fun | ✅ working | Both live. VidNest embed for One Piece S1E1 loads an ArtPlayer page; provider extracts `sources:` or falls back to the embed. |
| **toonstream** | toon-stream.site | 🔧 repaired | `toonstream.one/.dad` now 30x → **toon-stream.site** (`.co` 500s, `.day/.link` dead). Episode pages changed format: servers are now a download-table of anchors (rubystm/gdmirrorbot/cloudy/vidmoly/openx) instead of `aa-tbs` iframes. Added mirror list update + anchor-based server collection; rubystm/vidmoly/cloudy resolvers already existed. Site search is JS-gated server-side, so slug probing stays the discovery path. |
| **animelok** | animelok.live | ✅ working | `GET /api/anime/one-piece-21/episodes/1` returns direct `anixl-master.m3u8` servers (sub/dub/Hindi/Tamil/…), 720p/1080p pahe vault variants and `.vtt` captions. |
| **aniworld** | aniworld.to | ✅ working | Site live (German catalog). Cloudflare-protected — uses the fetch-bypass path in server contexts. |
| **reanime** | reanime.to API | ✅ working | `GET /api/flix/21/1` returns 8 FlixCloud servers (sub+dub, HD-1/HD-2); provider decrypts to HLS via the flixcloud resolver. |
| **fouranime** | 4anime.com.ro | ✅ working | `.gg`/`.to` dead, `.com.ro` live with the exact WordPress structure the scraper expects (`/anime/{slug}/`, `/{slug}-episode-{n}-english-subbed/`). Dead bases already probed in parallel. |
| **anikoto** | anikoto.cz | 🔧 repaired | `.to`/`.net` dead, `.cz` live (search, watch page, servers verified). Reordered `BASES` so the live origin is first — previously every search paid a dead-origin timeout. |
| **animeheaven** | animeheaven.me | ✅ working | `fastsearch.php` search verified live (One Piece → `anime.php?1ht8d`); gate.php → `video.mp4` flow intact. |
| **anizone** | anizone.to | 🔧 repaired | Site live; search now server-renders plain `/anime/{slug}` links instead of only Alpine JSON. Added a plain-HTML link parser as a fallback between the JSON and Livewire paths. Episode pages use the vidstack m3u8 player (One Piece → `uyyyn4kf`). |
| **animesalt** | animesalt.cx | 🔧 repaired | `.com/.link/.net/.top` dead. Site relocated to **animesalt.cx** (`animesalt.com` → `.ac` → `.cx`), same ToroFilm theme the scraper targets (`/series/one-piece/`, `/episode/one-piece-1x1/` verified). Updated `BASES` to `.cx`/`.ac`. |
| **animeblkom** | animeblkom.net | ✅ working | Site live (Arabic catalog). Search/watch-page scraping is best-effort against a JS-heavy site. |
| **desidub** | desidubanime.me | ✅ working | WP REST search verified live (`/wp-json/wp/v2/anime?search=…`). Base64-embed extraction unchanged. |
| **moviebox** | moviebox.ph (h5-api.aoneroom.com) | ➕ added | Ported from [walterwhite-69/Moviebox-API](https://github.com/walterwhite-69/Moviebox-API). API verified live: `home` (guest JWT via `x-user`), `media-player/get-domain` → `netfilm.world`, `subject/play` endpoint answers (streams unlock requires the JWT + player Referer, ported as in the reference). Direct MP4 (per-resolution) + HLS + captions; watch-page embed fallback when no resource. Covers movies (`movie()`) and TV (`single()`). |
| **watchanimeworld** | watchanimeworld.one | ♻️ restored | Round 2: rebuilt for the successor domain `watchanimeworld.one` per maintainer direction. Original `.com`/`.top`/`.net` hosts are dead; `.one` is Cloudflare-fronted (challenge pages detected and treated as misses, circuit breaker reworked). Same WordPress structure (`/?s=`, `/series/{slug}/`, `/episode/{slug}-{s}x{e}/`) and `player1.php` base64 server-list extraction (Hindi/Tamil/Telugu dubs). Live flow not machine-verifiable from the sandbox (CF gate) — extraction is covered by offline fixtures. |
| ~~senshi~~ | senshi.live | ❌ removed | Backend returns **HTTP 500 on every route** (`/`, `/anime`, `/episodes/1`, `/api/status`). Site registered 2025, currently broken → removed. |
| ~~mkissa~~ | mkissa.to | ❌ removed | Site live but gates every non-browser request behind a reCAPTCHA "Security Check" wall; the scraper can never return a result → removed. |

## Torrent audit (round 2)

| Provider | Upstream | Verdict | Evidence |
|:--|:--|:--|:--|
| **nyaa** | nyaa.si RSS | ✅ working | Live RSS returned fresh One Piece releases (Aug 2026) with info hashes. |
| **animetosho** | feed.animetosho.org/json | ✅ working | Live JSON: magnets, seeders, .torrent URLs all present. |
| **subplease** | subsplease.org/api | ✅ working | Live: One Piece 1173–1175 with 480p/720p/1080p magnets. |
| **seadex** | releases.moe (PocketBase) | ✅ working | `filter=alID=21&expand=trs` returns the A&C best releases with full file lists. |
| **nekobt** | nekobt.to torznab | ✅ working | Torznab search returns items with magnets, seeders, sizes. |
| **aniliberty** | aniliberty.top / anilibria.top | 🔧 rewritten | The HTML scrape 404'd (`/search?q=` is gone). Rewritten onto the verified JSON API: `api/v1/app/search/releases` + `api/v1/anime/torrents/release/{id}` (magnets, seeders, sizes confirmed live — 131 seeders on a Frieren batch). |
| ~~acgrip~~ | acg.rip | ❌ removed | Site is alive but its RSS search endpoint returns an **empty body for every term**, and the site itself announces `Tracker 不再有效` (tracker no longer valid) — discovery and downloading are both dead. |

Also fixed while testing: the shared episode-range parser missed batches like
`[1-28]` (1-digit range starts), so SubsPlease-style packs were filtered out of
episode-specific searches; the range regexes now accept `1-28` shapes.

## Notable upstream changes handled

- ToonStream/AnimeSalt/AniZone theme migrations (new markup, mirrors).
- Domain rotations: animepahe → `.pw`, anikoto → `.cz`, animesalt → `.cx`,
  animelok → `.live`, toonstream → `toon-stream.site`, 4anime → `.com.ro`.
- `manifest.json` permissions refreshed: dead domains dropped, live ones added
  (moviebox upstreams, toonstream server hosts, animelok HLS CDNs).

## Tooling

- `tests/check-providers.ts` — live fan-out harness (`npx tsx tests/check-providers.ts`).
  Note: it needs an environment with open egress to the streaming origins; in a
  network-restricted sandbox every provider reports empty by design.
- `tests/smoke-moviebox-anizone.test.ts` — offline fixtures validating the new
  moviebox provider end-to-end, the anizone search fallback, and the registry.
- `tests/smoke-round2.test.ts` — offline fixtures for the WAW restore (player1
  decode, CF-challenge handling, iframe filtering), the AniLiberty JSON rewrite,
  and the torrent registry.
