"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detectSeason, lookupAvailability, enrichPlatforms, LOOKUP_VERSION } = require("../scripts/enrich-platforms");
const es = { code: "ES", lang: "es" };
const netflix = { package: { technicalName: "netflix" }, standardWebURL: "https://www.netflix.com/title/season", monetizationType: "FLATRATE" };
const crunchyroll = { package: { technicalName: "crunchyroll" }, standardWebURL: "https://www.crunchyroll.com/series/first", monetizationType: "FLATRATE" };

test("season markers require explicit evidence and contradictions remain unknown", () => {
  const cases = [
    ["Example 2nd Season", [], 2], ["Example Second Season", [], 2],
    ["Example Third Season", [], 3], ["Example Fourth Season", [], 4],
    ["Example Season 12", [], 12], ["Example 2ª temporada", [], 2],
    ["Example II", [], 2], ["Example III", [], 3], ["Example IV", [], 4], ["Example V", [], 5],
    ["Example 2", [], null], ["Example 2", ["Example Season 2"], 2],
    ["Example Season 2", ["Example Season 3"], null], ["Example II", ["Example Third Season"], null],
    ["Example Season 2 Part 3", [], 2], ["Example 2nd Season 3rd Cour", [], 2],
    ["Example Part 2", [], null], ["Example Cour 3", [], null], ["Example 2nd Cour", [], null],
    ["Mob Psycho 100", [], null], ["Re:Zero", [], null], ["86", [], null],
    ["Example (2026)", [], null], ["Example 2026", [], null], ["Example Season 2026", [], null],
    ["Example Season 1", [], 1], ["Example Season2", [], 2]
  ];
  for (const [title, titles, expected] of cases) assert.equal(detectSeason({ title, titles }), expected, title);
  assert.equal(detectSeason({ title: "Example", anilistTitle: "Example Season 2" }), 2);
});

for (const known of [false, true]) test(`season offers replace parent offers (${known ? "BY_ID" : "SEARCH"})`, async () => {
  const cases = [
    ["Sample Season 2", [{ content: { seasonNumber: 1 }, offers: [netflix] }, { content: { seasonNumber: 2 }, offers: [] }], "no-offers", null, 2],
    ["Sample Season 2", [{ content: { seasonNumber: 1 }, offers: [netflix] }], "no-offers", null, 2],
    ["Sample Season 2", undefined, "no-offers", null, 2],
    ["Sample Season 2", [{ content: { seasonNumber: 2 }, offers: [netflix] }], "verified", "Netflix", 2],
    ["Sample Season 1", [{ content: { seasonNumber: 1 }, offers: [crunchyroll] }], "verified", "Crunchyroll", 1],
    ["Sample", [{ content: { seasonNumber: 1 }, offers: [crunchyroll] }], "verified", "Crunchyroll", 1],
    ["Sample", [{ content: { seasonNumber: 1 }, offers: [] }], "verified", "Netflix", null],
    ["Sample", undefined, "verified", "Netflix", null],
    ["Sample Season 2 Season 3", [{ content: { seasonNumber: 1 }, offers: [crunchyroll] }], "verified", "Crunchyroll", 1],
    ["Sample Season 1", undefined, "verified", "Netflix", null]
  ];
  for (const [title, seasons, status, service, season] of cases) {
    const item = { title, titles: [title], anilistOffers: [{ service: "Netflix", url: netflix.standardWebURL }] };
    const node = { id: "ts1", objectType: "SHOW", content: { title }, offers: [netflix], seasons };
    const result = await lookupAvailability(item, es, { knownId: known ? node.id : undefined, fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.query, /seasons\s*\{/);
      assert.match(body.query, /seasonNumber/);
      return Response.json({ data: known ? { node } : { popularTitles: { edges: [{ node }] } } });
    } });
    assert.equal(result.status, status, title);
    assert.equal(result.offers[0]?.service || null, service, title);
    assert.equal(result.season, season, title);
    assert.equal(result.justwatchId, "ts1");
    assert.equal(result.matchedTitle, title);
  }
});

test("season correction persists metadata without waiting for an unrelated availability retry", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const row = { id: "s2", animeKey: "sample", title: "Sample Season 2", releaseDate: "2026-11-08T12:00:00Z", episodeNumber: 1 };
  const previous = { status: "verified", offers: [{ service: "Netflix", url: netflix.standardWebURL }], lookupVersion: LOOKUP_VERSION - 1 };
  const result = await enrichPlatforms({ source: "test", releases: [row] }, { series: { sample: { countries: { ES: previous } } } }, {
    now, lookup: async () => ({ status: "no-offers", offers: [], justwatchId: "ts1", matchedTitle: "Sample", aliases: ["Sample Season 2"], season: 2 })
  });
  const record = result.cache.series.sample.countries.ES;
  assert.equal(record.status, "no-offers");
  assert.equal(record.season, 2);
  assert.equal(record.lookupVersion, LOOKUP_VERSION);
  assert.equal(record.checkedAt, new Date(now).toISOString());
  assert.equal(record.justwatchId, "ts1");
  assert.equal(record.matchedTitle, "Sample");
  assert.deepEqual(record.aliases, ["Sample Season 2"]);
  assert.ok(record.inputSignature);
  assert.equal(result.payload.releases[0].id, row.id);
});

test("all 76 real schedule titles and aliases have manually reviewed season expectations (2026-11-07)", () => {
  const cases = require("./fixtures/platform-seasons-2026-11-07.json");
  assert.equal(cases.length, 76);
  for (const item of cases) assert.equal(detectSeason(item), item.season, `${item.key}: ${item.title}`);
});

test("season-aware records still require confirmation on later availability losses", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const row = { id: "s2", animeKey: "sample", title: "Sample Season 2", releaseDate: "2026-11-08T12:00:00Z", episodeNumber: 1 };
  const previous = { status: "verified", offers: [{ service: "Netflix", url: netflix.standardWebURL }], season: 2, lookupVersion: LOOKUP_VERSION };
  const result = await enrichPlatforms({ releases: [row] }, { series: { sample: { countries: { ES: previous } } } }, {
    now, lookup: async () => ({ status: "no-offers", offers: [], season: 2 })
  });
  const record = result.cache.series.sample.countries.ES;
  assert.equal(record.status, "verified");
  assert.equal(record.pendingNegative.status, "no-offers");
});

test("season migration cannot bypass F2 mass-loss protection", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, animeKey: `sample${i}`, title: `Sample ${i} Season 2`, releaseDate: "2026-11-08T12:00:00Z", episodeNumber: 1 }));
  const previous = { status: "verified", offers: [{ service: "Netflix", url: netflix.standardWebURL }], lookupVersion: LOOKUP_VERSION - 1 };
  const cache = { series: Object.fromEntries(rows.map(row => [row.animeKey, { countries: { ES: previous } }])) };
  const result = await enrichPlatforms({ releases: rows }, cache, {
    now, concurrency: 10, lookup: async () => ({ status: "no-offers", offers: [], season: 2 })
  });
  assert.equal(result.summary.degraded[0].receivedVerified, 0);
  for (const entry of Object.values(result.cache.series)) assert.deepEqual(entry.countries.ES, previous);
});

test("a cached JustWatch parent alias cannot supply the item's season", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const row = { id: "p", animeKey: "tennis", title: "The Prince of Tennis II U-17 WORLD CUP: Final Member Selection Match", releaseDate: "2026-11-08T12:00:00Z", episodeNumber: 1 };
  const cache = { series: { tennis: { aliases: ["The Prince of Tennis II"], countries: {} } } };
  const result = await enrichPlatforms({ releases: [row] }, cache, { now, lookup: (item, country, options) => lookupAvailability(item, country, {
    ...options, knownId: "ts1", fetchImpl: async () => Response.json({ data: { node: {
      id: "ts1", objectType: "SHOW", content: { title: "The Prince of Tennis II" }, offers: [netflix],
      seasons: [{ content: { seasonNumber: 1 }, offers: [crunchyroll] }, { content: { seasonNumber: 2 }, offers: [] }]
    } } })
  }) });
  const record = result.cache.series.tennis.countries.ES;
  assert.equal(record.season, 1);
  assert.equal(record.offers[0].service, "Crunchyroll");
});
