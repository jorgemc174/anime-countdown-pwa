"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../platform-policy");
const { lookupAvailability, enrichPlatforms } = require("../scripts/enrich-platforms");
const now = Date.parse("2026-10-30T12:00:00Z");
const row = { id: "a4", animeKey: "sample", title: "Sample", episodeNumber: 4,
  releaseDate: "2026-11-01T18:00:00Z", service: "Crunchyroll", serviceUrl: "https://www.crunchyroll.com/series/a", allServices: ["Crunchyroll"] };
const payload = { source: "AnimeSchedule", updatedAt: "2026-10-30T10:00:00Z", releases: [row, { ...row, id: "a5", episodeNumber: 5, releaseDate: "2026-11-08T18:00:00Z" }] };
const offers = [{ service: "Netflix", url: "https://www.netflix.com/title/a", monetizationType: "FLATRATE" }];
const es = policy.COUNTRIES.find(country => country.code === "ES");
const mx = policy.COUNTRIES.find(country => country.code === "MX");
const positive = { status: "verified", offers };

test("backend checks each series once per country, including existing Crunchyroll series", async () => {
  const calls = [];
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es, mx], lookup: async (item, country) => { calls.push([item.title, country.code]); return positive; } });
  assert.equal(calls.length, 2);
  assert.equal(result.summary.series, 1);
  for (const enriched of result.payload.releases) {
    assert.equal(enriched.service, "Netflix");
    assert.equal(enriched.platformsByCountry.ES.status, "verified");
    assert.equal(enriched.platformsByCountry.MX.status, "verified");
    assert.equal(enriched.basePlatforms.service, "Crunchyroll");
  }
  assert.deepEqual(result.payload.releases.map(item => [item.id, item.episodeNumber, item.releaseDate]), payload.releases.map(item => [item.id, item.episodeNumber, item.releaseDate]));
  assert.equal(result.payload.updatedAt, payload.updatedAt);
});
test("fresh shared cache serves every device without another upstream check", async () => {
  const first = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => positive });
  const second = await enrichPlatforms(payload, first.cache, { now: now + 3600000, countries: [es], lookup: async () => { throw Error("must not run"); } });
  assert.equal(second.summary.checked, 0);
  assert.equal(second.payload.releases[0].service, "Netflix");
});
test("upstream errors retain the last confirmed offers and their original verification date", async () => {
  const first = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => positive });
  const second = await enrichPlatforms(payload, first.cache, { now: now + 13 * 3600000, countries: [es], lookup: async () => { throw Error("offline"); } });
  const item = second.payload.releases[0];
  assert.equal(item.service, "Netflix");
  assert.equal(item.platformStale, true);
  assert.equal(item.jwVerifiedAt, new Date(now).toISOString());
  assert.equal(second.summary.errors, 1);
});
test("negative regional results do not borrow another country's availability", () => {
  const item = { ...row, platformsByCountry: { ES: { ...positive, checkedAt: new Date(now).toISOString() }, MX: { status: "no-offers", offers: [] } } };
  const spanish = policy.applyCountryPlatforms(item, "ES", now);
  const mexican = policy.applyCountryPlatforms(spanish, "MX", now);
  assert.equal(spanish.service, "Netflix");
  assert.equal(mexican.service, "No legal platform");
  assert.equal(mexican.serviceUrl, "");
  assert.equal(mexican.hasAllowedPlatform, false);
  assert.equal(mexican.jwVerified, false);
  assert.deepEqual(mexican.serviceUrls, {});
});
test("inconclusive regional searches never expose global AnimeSchedule or AniList platforms", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => ({ status: "not-found", offers: [] }) });
  assert.equal(result.payload.releases[0].service, "No legal platform");
  assert.equal(result.payload.releases[0].serviceUrl, "");
  assert.deepEqual(result.payload.releases[0].allServices, []);
  assert.equal(result.payload.releases[0].basePlatforms.service, "Crunchyroll");
  assert.equal(result.payload.releases[0].jwVerified, false);
  assert.equal(result.summary.coverage.ES.pending, 0);
});
test("ambiguous titles and live-action/movie mismatches are not accepted", () => {
  const node = { id: "ts1", objectType: "SHOW", content: { title: "Sample", originalReleaseYear: 1999 } };
  assert.equal(policy.findMatch(row, [node, { ...node, id: "ts2", content: { title: "Sample", originalReleaseYear: 2023 } }]), null);
  assert.equal(policy.findMatch({ ...row, anilistYear: 1999 }, [node, { ...node, id: "ts2", content: { title: "Sample", originalReleaseYear: 2023 } }]).id, "ts1");
  assert.equal(policy.findMatch(row, [{ ...node, objectType: "MOVIE" }]), null);
  assert.equal(policy.findMatch(row, [{ ...node, content: { title: "Sample Spin-off" } }]), null);
  assert.equal(policy.findMatch({ ...row, anilistYear: 2023 }, [node]), null);
});
test("paid offers are excluded and add-on channels remain separate subscriptions", () => {
  const allowed = policy.allowedOffers({ offers: [
    { package: { technicalName: "netflix", clearName: "Netflix" }, standardWebURL: offers[0].url, monetizationType: "FLATRATE" },
    { package: { technicalName: "amazoncrunchyroll", clearName: "Crunchyroll Amazon Channel" }, standardWebURL: "https://www.primevideo.com/a", monetizationType: "FLATRATE" },
    { package: { technicalName: "amazon", clearName: "Amazon" }, standardWebURL: "https://www.amazon.es/a", monetizationType: "RENT" }
  ] });
  assert.equal(allowed.length, 2);
  assert.ok(allowed.some(offer => offer.service === "Crunchyroll Amazon Channel"));
  assert.ok(!allowed.some(offer => offer.service === "Crunchyroll"));
});
test("expired budgets leave records queued for future automatic runs", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es], budgetMs: 0, lookup: async () => { throw Error("must not run"); } });
  assert.equal(result.summary.queued, 1);
  assert.equal(result.summary.coverage.ES.pending, 1);
});
test("backend GraphQL requests have the selected region and return normalized offers", async () => {
  const result = await lookupAvailability(row, es, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://apis.justwatch.com/graphql");
    const body = JSON.parse(options.body);
    assert.equal(body.variables.country, "ES");
    assert.equal(body.variables.language, "es");
    return Response.json({ data: { popularTitles: { edges: [{ node: { id: "ts1", objectType: "SHOW", content: { title: "Sample" }, offers: [
      { package: { technicalName: "netflix" }, standardWebURL: offers[0].url, monetizationType: "FLATRATE" }
    ] } }] } } });
  } });
  assert.equal(result.status, "verified");
  assert.equal(result.offers[0].service, "Netflix");
});
test("GraphQL errors cannot be interpreted as no regional offers", async () => {
  await assert.rejects(lookupAvailability(row, es, { fetchImpl: async () => Response.json({ errors: [{ message: "rate limited" }] }) }));
});
test("rate limits stop the batch and leave other series for the next automatic run", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es, mx], concurrency: 1,
    lookup: async () => { const error = Error("rate limited"); error.status = 429; throw error; } });
  assert.equal(result.summary.checked, 1);
  assert.equal(result.summary.queued, 1);
  assert.equal(result.summary.rateLimited, true);
});
