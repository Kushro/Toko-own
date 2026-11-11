# Changelog

## Unreleased (Kushro/Toko-own)

Torrent matching, with ideas taken from anitorrent (reimplemented, no code copied).

- AnimeTosho looks up by AniDB id from ani.zip: `?eid=` for the episode, then `?aid=` for the show, and only then
  the text search. An id lookup is the right show by construction.
- Cour-split shows: the AniList prequel chain gives the numbers groups use across an arc ("BLEACH TYBW - The
  Calamity" episode 9 also finds "- 49", "The Apothecary Diaries" S3E6 also finds "- 54"). When several numbers
  match, the one with the freshest upload wins.
- An episode AniList says has not aired returns nothing on Nyaa, AnimeTosho and SubsPlease, unless an exact match
  was uploaded in the last week (groups beat the broadcast schedule). Before, it returned an earlier cour's file or,
  on SubsPlease, the latest episodes.
- Packs are no longer thrown away for an episode request: a pack whose range covers the episode ranks after exact
  matches, and unlabelled releases only show when nothing exact exists. A release naming another episode is out.
- One-word shows ("Another", "Monster") no longer take releases that add words ("In Another World With My
  Smartphone"), and an arc entry no longer takes a sibling arc ("Soukoku-tan" against "Kashin-tan"). How many show
  words a release must carry comes from the show's main title, not the short search query ("Bleach").

## 4.5.9 - 2026-11-10 (Kushro/Toko-own)

Fork build for Tatakai Next's native host (on top of upstream 4.5.8).

- Torrent search uses several titles: the English and the romaji ones, the part before a colon and a version without
  symbols ("Magical★Explorer" → "Magical Explorer"); before, only the first title was searched and a long display
  title (a 90-character romaji) found nothing on nyaa or SubsPlease.
- Seasons: "… Part 2", "Season 2", "2nd Season", "第二幕" are read from the titles; the search adds `S02E03` /
  `S2 - 03`, and releases of another season are dropped (an unmarked "Title - 03" no longer answers a season 2
  request).
- Nyaa keeps up to 50 releases per episode (was 20).
- Runs in the native Tatakai host: undici stubbed, bootstrap builtins loaded lazily; API exposure, scraper URL
  handling and browser bootstrap hardened.

## 4.5.8 - 2026-10-28

- Preserve every Atsu upstream for each manga, novel, and webnovel chapter, with readable source labels and stable selections. Existing reading links remain supported.
- Add Manta chapter-novel search and public free chapters through its normal browser reader. Paid, membership, and Free Pass unlocks are not performed.
- Add Scribble Hub search, full chapter catalogs, and prose reading.
- Load Webnovel.com’s full catalog and canonical chapter URLs; include Webnovel, Royal Road, Atsu novels, Manta, and Scribble Hub in normal browser discovery.

## 4.5.7 - 2026-10-26

- Fix novel adapters incorrectly rejecting prose titles through the manga format matcher.
- Stream early manga and novel sources to compatible servers while retaining later provider results.

## 4.5.6 - 2026-10-26

- Bound manga and novel discovery, metadata waits and retry concurrency.
- Preserve later novel providers when invoked by a short-lived hosted worker.
- Normalize novel chapters to ordered text, excluding images and media URLs.

## 4.5.5 - 2026-10-15

- Add a dedicated Atsu prose-novel provider, keeping novels separate from comics.
- Read ordered chapter lists and normalized paragraphs from Atsu novel endpoints.
- Advertise novel capabilities and routes in the standalone API health response.

Update or reinstall toko.kai in Tatakai to use the new provider.
