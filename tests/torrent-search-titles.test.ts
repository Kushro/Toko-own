import { expect, test } from 'bun:test';
import { releaseSeason, searchTitles, seasonMismatch, seasonOf, stripSeason } from '../src/utils/torrent/search-titles';

test('search titles: short ones first, the part before a colon, symbol-free variants', () => {
  expect(searchTitles(['Magical★Explorer: Eroge no Yuujin Chara ni Tensei Shitakedo, Game Chishiki Tsukatte Jiyuu ni Ikiru'])).toEqual(['Magical Explorer', 'Magical★Explorer']);
  expect(searchTitles(['Though I Am an Inept Villainess', 'Futsutsuka na Akujo de wa Gozaimasu ga: Suuguu Chouso Torikae Den'])).toEqual(['Though I Am an Inept Villainess', 'Futsutsuka na Akujo de wa Gozaimasu ga']);
});

test('season of AniList titles', () => {
  expect(seasonOf(['Futsutsuka na Akujo de wa Gozaimasu ga: Suuguu Chouso Torikae Den Part 2'])).toBe(2);
  expect(seasonOf(['Sousou no Frieren 2nd Season'])).toBe(2);
  expect(seasonOf(["Frieren: Beyond Journey's End Season 2"])).toBe(2);
  expect(seasonOf(['葬送のフリーレン 第2期'])).toBe(2);
  expect(seasonOf(['ふつつかな悪女ではございますが ～雛宮蝶鼠とりかえ伝～ 第二幕'])).toBe(2);
  expect(seasonOf(['Overlord III'])).toBe(3);
  expect(seasonOf(['Magical Explorer', 'Though I Am an Inept Villainess'])).toBeNull();
  expect(stripSeason('Sousou no Frieren 2nd Season')).toBe('Sousou no Frieren');
  expect(stripSeason('Foo: Bar Part 2')).toBe('Foo: Bar');
});

test('season of release names and the mismatch rule', () => {
  expect(releaseSeason('[ToonsHub] Frieren Beyond Journeys End S02E03 1080p')).toBe(2);
  expect(releaseSeason('[SubsPlease] Sousou no Frieren S2 - 03 (1080p)')).toBe(2);
  expect(releaseSeason('[Erai-raws] Sousou no Frieren 2nd Season - 03 [1080p]')).toBe(2);
  expect(releaseSeason('[SubsPlease] Magical Explorer - 06 (1080p)')).toBeNull();
  expect(seasonMismatch('[X] Show S01E03', 2)).toBe(true);
  expect(seasonMismatch('[X] Show S02E03', null)).toBe(true);
  expect(seasonMismatch('[X] Show S01E10', null)).toBe(false);
  expect(seasonMismatch('[X] Show - 10', null)).toBe(false);
});

test('search titles: no trailing year, generic one-word titles last', () => {
  expect(searchTitles(['False Memory (2026)'])).toEqual(['False Memory']);
  expect(searchTitles(['Monster #8', 'Kaijuu 8-gou'])[0]).toBe('Kaijuu 8-gou');
  expect(searchTitles(['Another'])).toEqual(['Another']);
});
