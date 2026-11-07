"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../platform-policy");
const { LOOKUP_VERSION, lookupAvailability, enrichPlatforms } = require("../scripts/enrich-platforms");
const now = Date.parse("2026-10-30T12:00:00Z");
const row = { id: "a4", animeKey: "sample", title: "Sample", episodeNumber: 4,
  releaseDate: "2026-11-01T18:00:00Z", service: "Crunchyroll", serviceUrl: "https://www.crunchyroll.com/series/a", allServices: ["Crunchyroll"] };
const payload = { source: "AnimeSchedule", updatedAt: "2026-10-30T10:00:00Z", releases: [row, { ...row, id: "a5", episodeNumber: 5, releaseDate: "2026-11-08T18:00:00Z" }] };
const offers = [{ service: "Netflix", url: "https://www.netflix.com/title/a", monetizationType: "FLATRATE" }];
const es = policy.COUNTRIES.find(country => country.code === "ES");
const mx = { code: "MX", name: "México", lang: "es" };
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
test("default policy only queries Spain and prunes all cached and published countries", async () => {
  assert.deepEqual(policy.COUNTRIES.map(country => country.code), ["ES"]);
  const record = { ...positive, checkedAt: new Date(now).toISOString(), lookupVersion: LOOKUP_VERSION };
  const cache = { version: 1, series: {
    sample: { countries: { ES: record, MX: { ...record, justwatchId: "mexican" } } },
    absent: { lastSeenAt: new Date(now).toISOString(), countries: { ES: record, MX: record } }
  } };
  const input = { ...payload, releases: [
    ...payload.releases.map(item => ({ ...item, platformsByCountry: { ES: record, MX: record } })),
    { ...row, id: "cancelled", animeKey: "absent", scheduleStatus: "cancelled", platformsByCountry: { MX: record } }
  ] };
  const result = await enrichPlatforms(input, cache, { now, lookup: async () => { throw Error("must not run"); } });
  assert.equal(result.summary.checked, 0);
  for (const entry of Object.values(result.cache.series)) {
    assert.deepEqual(Object.keys(entry.countries), ["ES"]);
    assert.deepEqual(entry.countries.ES, record);
  }
  for (const item of result.payload.releases) {
    assert.deepEqual(Object.keys(item.platformsByCountry), ["ES"]);
    assert.deepEqual(item.platformsByCountry.ES, record);
  }
  assert.deepEqual(cache.series.sample.countries.ES, record);
  assert.ok(cache.series.sample.countries.MX);
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
test("negative regional results fall back to source links without borrowing verified offers", () => {
  const item = { ...row, platformsByCountry: { ES: { ...positive, checkedAt: new Date(now).toISOString() }, MX: { status: "no-offers", offers: [] } } };
  const spanish = policy.applyCountryPlatforms(item, "ES", now);
  const mexican = policy.applyCountryPlatforms(spanish, "MX", now);
  assert.equal(spanish.service, "Netflix");
  assert.equal(mexican.service, "Crunchyroll");
  assert.equal(mexican.serviceUrl, row.serviceUrl);
  assert.equal(mexican.hasAllowedPlatform, true);
  assert.equal(mexican.jwVerified, false);
  assert.deepEqual(mexican.serviceUrls, { Crunchyroll: row.serviceUrl });
});
test("inconclusive regional searches use linked AnimeSchedule platforms", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => ({ status: "not-found", offers: [] }) });
  assert.equal(result.payload.releases[0].service, "Crunchyroll");
  assert.equal(result.payload.releases[0].serviceUrl, row.serviceUrl);
  assert.deepEqual(result.payload.releases[0].allServices, ["Crunchyroll"]);
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
test("a season resolves to its parent series without confusing spin-offs or remakes", () => {
  const node = { id: "aoashi", objectType: "SHOW", content: { title: "Ao Ashi", originalReleaseYear: 2022 } };
  assert.equal(policy.findMatch({ title: "Ao Ashi 2nd Season", anilistYear: 2026 }, [node]).id, "aoashi");
  assert.equal(policy.findMatch({ title: "Ao Ashi Special 2nd Season" }, [node]), null);
  assert.equal(policy.findMatch({ title: "Ranma (2024) 3rd Season" }, [{ ...node, content: { title: "Ranma" } }]), null);
});
test("localized names use English metadata but keep the same country for offers", async () => {
  const calls = [];
  const result = await lookupAvailability({ title: "Ao no Exorcist", anilistTitle: "Blue Exorcist" }, es, { fetchImpl: async (url, options) => {
    const { variables } = JSON.parse(options.body);
    calls.push(variables);
    return Response.json({ data: { popularTitles: { edges: [{ node: { id: "blue", objectType: "SHOW", content: { title: variables.language === "en" ? "Blue Exorcist" : "El exorcista azul" }, offers: [
      { package: { technicalName: "crunchyroll" }, standardWebURL: "https://www.crunchyroll.com/series/blue", monetizationType: "FLATRATE" }
    ] } }] } } });
  } });
  assert.equal(result.status, "verified");
  assert.equal(result.offers[0].service, "Crunchyroll");
  assert.ok(calls.every(call => call.country === "ES"));
});
test("a missing English alias is resolved from AniList before retrying JustWatch in the same country", async () => {
  let resolved = 0;
  const countries = [];
  const result = await lookupAvailability({ title: "Ao no Exorcist" }, es, { fetchImpl: async (url, options) => {
    if (url === "https://graphql.anilist.co") {
      resolved++;
      return Response.json({ data: { Media: { id: 9919, title: { romaji: "Ao no Exorcist", english: "Blue Exorcist" }, synonyms: [] } } });
    }
    countries.push(JSON.parse(options.body).variables.country);
    return Response.json({ data: { popularTitles: { edges: [{ node: { id: "blue", objectType: "SHOW", content: { title: "Blue Exorcist" }, offers: [
      { package: { technicalName: "crunchyroll" }, standardWebURL: "https://www.crunchyroll.com/series/blue", monetizationType: "FLATRATE" }
    ] } }] } } });
  } });
  assert.equal(resolved, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.offers[0].service, "Crunchyroll");
  assert.ok(countries.every(country => country === "ES"));
});
test("an unrelated AniList search result cannot introduce aliases for a different anime", async () => {
  const result = await lookupAvailability({ title: "Ao no Exorcist" }, es, { fetchImpl: async url => {
    if (url === "https://graphql.anilist.co") return Response.json({ data: { Media: { id: 7, title: { romaji: "Different anime", english: "Wrong alias" } } } });
    return Response.json({ data: { popularTitles: { edges: [] } } });
  } });
  assert.equal(result.status, "not-found");
  assert.deepEqual(result.offers, []);
});
test("original Japanese titles and season markers resolve short native names", () => {
  const item = { title: "Koori no Jouheki 2nd Season", anilistTitle: "The Ramparts of Ice Season 2", titles: ["氷の城壁 第2期"] };
  const node = { id: "ice", objectType: "SHOW", content: { title: "Localized name", originalTitle: "氷の城壁" } };
  assert.equal(policy.findMatch(item, [node]).id, "ice");
  assert.ok(policy.searchTitles(item).includes("氷の城壁"));
});
test("roman-numeral TV sequels can find their parent without changing film identity", () => {
  const item = { title: "The Iceblade Sorcerer Shall Rule the World II" };
  const node = { id: "iceblade", objectType: "SHOW", content: { title: "The Iceblade Sorcerer Shall Rule the World" } };
  assert.equal(policy.findMatch(item, [node]).id, "iceblade");
  assert.equal(policy.findMatch({ ...item, format: "MOVIE" }, [{ ...node, objectType: "MOVIE" }]), null);
});
test("The Ramparts of Ice matches the Jouheki/Jyouheki romanization variant", () => {
  const item = { title: "Koori no Jouheki 2nd Season", anilistTitle: "The Ramparts of Ice Season 2" };
  const node = { id: "ramparts", objectType: "SHOW", content: { title: "Koori no Jyouheki", originalTitle: "Koori no Jyouheki" } };
  assert.equal(policy.findMatch(item, [node]).id, "ramparts");
});
test("known JustWatch IDs survive renamed or translated catalog titles", async () => {
  let calls = 0;
  const result = await lookupAvailability(row, es, { previous: { status: "verified", justwatchId: "ts-known", lookupVersion: LOOKUP_VERSION }, fetchImpl: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.operationName, "GetKnownTitle");
    assert.equal(body.variables.country, "ES");
    assert.equal(body.variables.id, "ts-known");
    return Response.json({ data: { node: { id: "ts-known", objectType: "SHOW", content: { title: "New localized title" }, offers: [
      { package: { technicalName: "crunchyroll" }, standardWebURL: "https://www.crunchyroll.com/series/same", monetizationType: "FLATRATE" }
    ] } } });
  } });
  assert.equal(result.status, "verified");
  assert.equal(result.offers[0].service, "Crunchyroll");
  assert.equal(calls, 1);
});
test("a single empty catalog response cannot remove a known regional platform", async () => {
  const first = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => positive });
  const negative = async () => ({ status: "no-offers", offers: [] });
  const second = await enrichPlatforms(payload, first.cache, { now: now + 13 * 3600000, countries: [es], lookup: negative });
  assert.equal(second.payload.releases[0].service, "Netflix");
  assert.ok(second.cache.series.sample.countries.ES.pendingNegative);
  assert.ok(second.summary.issues.some(issue => issue.reason === "availability-change-needs-confirmation"));
  const early = await enrichPlatforms(payload, second.cache, { now: now + 14 * 3600000, countries: [es], lookup: negative });
  assert.equal(early.summary.checked, 0);
  const confirmed = await enrichPlatforms(payload, second.cache, { now: now + 16 * 3600000, countries: [es], lookup: negative });
  assert.equal(confirmed.payload.releases[0].service, "Crunchyroll");
  assert.ok(confirmed.summary.issues.some(issue => issue.reason === "confirmed-availability-removed"));
});
test("new source names invalidate cached misses immediately", async () => {
  const first = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => ({ status: "not-found", offers: [] }) });
  const renamed = { ...payload, releases: payload.releases.map(item => ({ ...item, anilistTitle: "New English alias" })) };
  const second = await enrichPlatforms(renamed, first.cache, { now: now + 3600000, countries: [es], lookup: async () => positive });
  assert.equal(second.summary.checked, 1);
  assert.equal(second.payload.releases[0].service, "Netflix");
});
test("learned aliases accumulate across countries instead of replacing one another", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es, mx], lookup: async (item, country) => ({ ...positive, aliases: [country.code === "ES" ? "Spanish alias" : "Mexican alias"] }) });
  assert.ok(result.cache.series.sample.aliases.includes("Spanish alias"));
  assert.ok(result.cache.series.sample.aliases.includes("Mexican alias"));
});
test("Retry-After is retained across automatic runs and prevents repeated throttled requests", async () => {
  let calls = 0;
  const lookup = (item, country, options) => lookupAvailability(item, country, { ...options, fetchImpl: async () => {
    calls++;
    return new Response("limited", { status: 429, headers: { "retry-after": "7200" } });
  } });
  const first = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup });
  assert.equal(first.cache.cooldowns.JustWatch, new Date(now + 7200000).toISOString());
  assert.equal(first.summary.totalFailure, true);
  await enrichPlatforms(payload, first.cache, { now: now + 3600000, countries: [es], lookup });
  assert.equal(calls, 1);
});
test("platform lookup failures appear in the audit while retaining source links", async () => {
  const result = await enrichPlatforms(payload, undefined, { now, countries: [es], lookup: async () => { throw Error("offline"); } });
  assert.equal(result.summary.totalFailure, true);
  assert.equal(result.summary.issues[0].reason, "lookup-error");
  assert.equal(result.summary.issues[0].country, "ES");
  assert.equal(result.payload.releases[0].hasAllowedPlatform, true);
});
test("a known catalog ID is reusable across countries but its offers are queried again locally", async () => {
  const result = await lookupAvailability(row, mx, { knownId: "ts-canonical", fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.variables.id, "ts-canonical");
    assert.equal(body.variables.country, "MX");
    return Response.json({ data: { node: { id: "ts-canonical", objectType: "SHOW", content: { title: "Título local" }, offers: [] } } });
  } });
  assert.equal(result.status, "no-offers");
  assert.deepEqual(result.offers, []);
});
test("unmatched shows use AniList links without claiming regional verification", () => {
  const item = policy.applyCountryPlatforms({ ...row, anilistOffers: [{ service: "Hulu", url: "https://www.hulu.com/series/sample" }], platformsByCountry: { ES: { status: "not-found", offers: [] } } }, "ES", now);
  assert.equal(item.service, "Hulu");
  assert.equal(item.serviceUrl, "https://www.hulu.com/series/sample");
  assert.equal(item.platformSource, "anilist");
  assert.equal(item.jwVerified, false);
});
test("JustWatch takes precedence and no-offers triggers AniList fallback", () => {
  const item = { ...row, anilistOffers: [{ service: "Hulu", url: "https://www.hulu.com/series/sample" }], platformsByCountry: { ES: { ...positive }, MX: { status: "no-offers", offers: [] } } };
  assert.equal(policy.applyCountryPlatforms(item, "ES", now).service, "Netflix");
  assert.equal(policy.applyCountryPlatforms(item, "MX", now).service, "Hulu");
});
test("AniList fallback only extracts genuine streaming links", () => {
  const offers = policy.anilistOffers({ externalLinks: [
    { site: "Crunchyroll", type: "STREAMING", url: "https://www.crunchyroll.com/series/sample" },
    { site: "Official Site", type: "INFO", url: "https://official.example" },
    { site: "Bad link", type: "STREAMING", url: "javascript:alert(1)" }
  ], streamingEpisodes: [{ site: "Crunchyroll", url: "https://www.crunchyroll.com/watch/episode" }] });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].service, "Crunchyroll");
});
test("AniList fallback is prepared and cached centrally without a user's library sync", async () => {
  const schedule = { ...payload, releases: payload.releases.map(item => ({ ...item, anilistOffers: [{ service: "Crunchyroll", url: "https://www.crunchyroll.com/series/sample" }] })) };
  const first = await enrichPlatforms(schedule, undefined, { now, countries: [es], lookup: async () => ({ status: "not-found", offers: [] }) });
  assert.equal(first.payload.releases[0].service, "Crunchyroll");
  assert.equal(first.payload.releases[0].platformSource, "anilist");
  const cached = await enrichPlatforms(payload, first.cache, { now: now + 3600000, countries: [es], lookup: async () => { throw Error("must not run"); } });
  assert.equal(cached.payload.releases[0].service, "Crunchyroll");
});

function catalogNode(title, service = "crunchyroll", id = title) {
  return { id, objectType: "SHOW", content: { title }, offers: [
    { package: { technicalName: service }, standardWebURL: "https://stream.example/show", monetizationType: "FLATRATE" }
  ] };
}
test("comparison romanization keeps cache keys unchanged", () => {
  for (const title of ["Sôsô no Frieren", "Sōsō no Frieren"]) {
    assert.equal(policy.findMatch({ title }, [catalogNode("Sousou no Frieren")])?.id, "Sousou no Frieren");
  }
  assert.equal(policy.findMatch({ title: "You & Me" }, [catalogNode("You and Me")])?.id, "You and Me");
  assert.equal(policy.findMatch({ title: "Sôsô no Furîren" }, [catalogNode("Sousou no Frieren")]), null);
  assert.equal(policy.findMatch({ title: "Sôsô no Furîren Extra" }, [catalogNode("Sousou no Frieren")]), null);
  assert.equal(policy.seriesKey({ title: "Sôsô no Furîren" }), "sôsônofurîren");
});
test("real JustWatch parent titles require corroboration and preserve remake identity", () => {
  for (const [title, parent, service, source] of [
    ["Tokyo Revengers: Santen Sensou-hen", "Tokyo Revengers", "disneyplus", "Disney+"],
    ["Tokyo Revengers: War of the Three Titans Arc", "Tokyo Revengers", "crunchyroll", "Crunchyroll"],
    ["Magical★Explorer: Eroge no Yuujin Chara ni Tensei Shitakedo…", "Magical★Explorer", "crunchyroll", "Crunchyroll"],
    ["Shin Tennis no Oujisama: U-17 World Cup Kesshou Member Ketteisen", "Shin Tennis no Ouji-sama", "crunchyroll", "Crunchyroll"],
    ["Ace of the Diamond Act II: Second Season Part 2", "Ace of the Diamond", "crunchyroll", "Crunchyroll"]
  ]) {
    const item = { title, anilistOffers: [{ service: source, url: "https://stream.example/a" }] };
    assert.equal(policy.findMatch(item, [catalogNode(parent, service)])?.id, parent, title);
    assert.ok(policy.searchTitles(item).includes(parent === "Shin Tennis no Ouji-sama" ? "Shin Tennis no Oujisama" : parent));
  }
  const dragon = catalogNode("Dragon Ball", "netflix");
  assert.equal(policy.findMatch({ title: "Dragon Ball: Daima", anilistOffers: [{ service: "Crunchyroll" }] }, [dragon]), null);
  assert.equal(policy.findMatch({ title: "Dragon Ball: Daima" }, [dragon]), null);
  assert.equal(policy.findMatch({ title: "Dragon Ball: Daima", format: "MOVIE", allServices: ["Netflix"] }, [{ ...dragon, objectType: "MOVIE" }]), null);
  assert.equal(policy.findMatch({ title: "Magic Knight Rayearth (2026)", allServices: ["Crunchyroll"] }, [catalogNode("Magic Knight Rayearth")]), null);
  assert.equal(policy.findMatch({ title: "Dragon Ball: Daima", allServices: ["Netflix"] }, [dragon, { ...dragon, id: "other" }]), null);
  assert.equal(policy.findMatch({ title: "Dragon Ball: Daima", allServices: ["Netflix"] }, [dragon])?.id, dragon.id);
});
test("reordered season titles select Steel Ball Run rather than JoJo 2012", () => {
  const steel = catalogNode("Steel Ball Run: JoJo's Bizarre Adventure", "netflix");
  const old = catalogNode("JoJo's Bizarre Adventure", "netflix");
  const item = { title: "JoJo's Bizarre Adventure: Steel Ball Run 2nd - 3rd STAGE", allServices: ["Netflix"] };
  assert.equal(policy.findMatch(item, [old, steel])?.id, steel.id);
  assert.equal(policy.findMatch({ ...item, allServices: [] }, [old]), null);
  assert.equal(policy.findMatch(item, [steel, { ...steel, id: "duplicate" }]), null);
  assert.equal(policy.findMatch({ title: "Example Show Title 2nd Stage" }, [catalogNode("Example Show Title")])?.id, "Example Show Title");
  assert.equal(policy.findMatch({ title: "Example Show Title Act 2" }, [catalogNode("Example Show Title")])?.id, "Example Show Title");
});
test("search roots follow full titles and never exceed six", () => {
  const item = { title: "Alpha Beta: Arc 2nd Season", anilistTitle: "Gamma Delta: Arc", titles: ["Other One: Arc", "Other Two: Arc", "Other Three: Arc", "Other Four: Arc"] };
  const titles = policy.searchTitles(item);
  assert.deepEqual(titles.slice(0, 2), [item.anilistTitle, item.title]);
  assert.ok(titles.length <= 6);
  assert.ok(titles.includes("Alpha Beta"));
  assert.deepEqual(policy.searchTitles({ title: item.title, format: "MOVIE" }), [item.title]);
});
test("fallback ladder validates URLs and retains only the linked AnimeSchedule service", () => {
  for (const status of [undefined, "not-found", "pending", "error", "no-offers"]) {
    const item = { ...row, anilistOffers: [{ service: "Hulu", url: "https://hulu.com/show" }], platformsByCountry: status ? { ES: { status } } : {} };
    const result = policy.applyCountryPlatforms(item);
    assert.equal(result.platformSource, "anilist", status);
    assert.equal(result.jwVerified, false);
    const base = policy.applyCountryPlatforms({ ...item, anilistOffers: [{ service: "Bad", url: "http://bad.example" }], allServices: ["Crunchyroll", "Netflix"] });
    assert.equal(base.platformSource, "animeschedule");
    assert.equal(base.hasAllowedPlatform, true);
    assert.deepEqual(base.allServices, ["Crunchyroll"]);
    assert.deepEqual(base.serviceUrls, { Crunchyroll: row.serviceUrl });
  }
  assert.equal(policy.applyCountryPlatforms({ ...row, serviceUrl: "http://bad.example" }).hasAllowedPlatform, false);
});
test("no-offers resolves AniList once across known and direct lookups and tolerates failure", async () => {
  for (const knownId of [undefined, "known"]) {
    for (const fail of [false, true]) {
      let calls = 0;
      const aliasCache = new Map();
      const fetchImpl = async url => {
        if (url === "https://graphql.anilist.co") {
          calls++;
          if (fail) throw Error("offline");
          return Response.json({ data: { Media: { id: 1, title: { romaji: row.title }, externalLinks: [{ site: "Hulu", type: "STREAMING", url: "https://hulu.com/show" }] } } });
        }
        const node = { ...catalogNode(row.title, "netflix", knownId || "direct"), offers: [] };
        return Response.json({ data: knownId ? { node } : { popularTitles: { edges: [{ node }] } } });
      };
      for (const country of [es, mx]) {
        const result = await lookupAvailability(row, country, { knownId, aliasCache, fetchImpl });
        assert.equal(result.status, "no-offers");
        if (!fail) assert.equal(result.anilistOffers[0].service, "Hulu");
      }
      assert.equal(calls, 1);
      await lookupAvailability({ ...row, anilistOffers: [{ service: "Hulu", url: "https://hulu.com/show" }] }, es, { knownId, fetchImpl });
      assert.equal(calls, 1);
    }
  }
});

test("reordered matches respect year, original titles and the three-word minimum", () => {
  const node = { ...catalogNode("Localized title"), content: { title: "Localized title", originalTitle: "Three Two One", originalReleaseYear: 2020 } };
  assert.equal(policy.findMatch({ title: "One Two Three", anilistYear: 2020 }, [node])?.id, node.id);
  assert.equal(policy.findMatch({ title: "One Two Three", anilistYear: 2026 }, [node]), null);
  assert.equal(policy.findMatch({ title: "One Two" }, [catalogNode("Two One")]), null);
  assert.equal(policy.findMatch({ title: "Show 86 Title 2nd Stage" }, [catalogNode("Show Title")]), null);
});
test("subtitle roots use both source services but never paid offers", () => {
  for (const separator of [": ", " - ", " ~ "]) {
    const item = { title: "Parent Show" + separator + "New Arc", basePlatforms: { allServices: ["Netflix"] } };
    const node = catalogNode("Parent Show", "netflix");
    assert.equal(policy.findMatch(item, [node])?.id, node.id);
    assert.equal(policy.findMatch(item, [{ ...node, offers: node.offers.map(offer => ({ ...offer, monetizationType: "RENT" })) }]), null);
    assert.ok(policy.searchTitles(item).includes("Parent Show"));
  }
});
test("a previous no-offers ID retains its result when AniList aliases are unavailable", async () => {
  const result = await lookupAvailability(row, es, {
    previous: { status: "no-offers", justwatchId: "known", lookupVersion: LOOKUP_VERSION }, aliasState: { unavailable: true },
    fetchImpl: async () => Response.json({ data: { node: { ...catalogNode("Renamed", "netflix", "known"), offers: [] } } })
  });
  assert.equal(result.status, "no-offers");
  assert.equal(result.justwatchId, "known");
});
test("title lookups without an AniList id omit the id and treat a 404 as no match", async () => {
  const anilistVariables = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!String(url).includes("anilist")) return new Response(JSON.stringify({ data: { popularTitles: { edges: [] } } }), { status: 200 });
    anilistVariables.push(body.variables);
    return new Response(JSON.stringify({ errors: [{ status: 404 }], data: { Media: null } }), { status: 404 });
  };
  const result = await lookupAvailability({ title: "Serie sin ficha", titles: ["Serie sin ficha"] }, { code: "ES", lang: "es" }, { fetchImpl });
  assert.equal(result.status, "not-found");
  assert.deepEqual(anilistVariables, [{ search: "Serie sin ficha" }]);
});


test("fallback brands require their own domain while JustWatch remains authoritative", () => {
  const cases = [
    ["Crunchyroll", "https://evilcrunchyroll.com/", false],
    ["Crunchyroll", "https://crunchyroll.com.evil.example/", false],
    ["Netflix", "https://unrelated.example/", false],
    ["Prime Video", "https://www.amazon.es/show", true],
    ["Prime Video", "https://amazon.evil/show", false],
    ["Crunchyroll", "https://www.crunchyroll.com/", true],
    ["Bilibili TV", "https://www.bilibili.tv/", true],
    ...[
      ["HIDIVE", "hidive.com"], ["Netflix", "netflix.com"], ["Disney+", "disneyplus.com"],
      ["Hulu", "hulu.com"], ["Max", "max.com"], ["Max", "hbomax.com"],
      ["Prime Video", "primevideo.com"], ["Apple TV+", "tv.apple.com"], ["Apple TV+", "apple.co"],
      ["YouTube", "youtube.com"], ["YouTube", "youtu.be"], ["Bilibili", "bilibili.com"],
      ["iQ", "iq.com"], ["iQIYI", "iqiyi.com"], ["OceanVeil", "oceanveil.net"],
      ["Tubi TV", "tubitv.com"], ["Crackle", "crackle.com"], ["Tencent Video", "v.qq.com"], ["WeTV", "wetv.vip"],
      ...["com", "es", "de", "fr", "it", "co.uk", "co.jp", "com.mx", "com.br"].map(tld => ["Prime Video", `amazon.${tld}`])
    ].flatMap(([service, host]) => [[service, `https://${host}/`, true], [service, "https://unrelated.example/", false]]),
    ["Unknown", "https://unrelated.example/", true],
    ["constructor", "https://unrelated.example/", true]
  ];
  for (const [service, url, accepted] of cases) {
    const offer = { service, url };
    const fallback = policy.applyCountryPlatforms({ anilistOffers: [offer] });
    assert.equal(fallback.platformSource, accepted ? "anilist" : "", `${service}: ${url}`);
    const schedule = policy.applyCountryPlatforms({ service, serviceUrl: url });
    assert.equal(schedule.platformSource, accepted ? "animeschedule" : "", `${service}: ${url}`);
    const verified = policy.applyCountryPlatforms({ platformsByCountry: { ES: { status: "verified", offers: [offer] } } });
    assert.equal(verified.platformSource, "justwatch");
  }
});
const jwNode = (id, title, year, service) => ({ id, objectType: "SHOW", content: { title, originalTitle: title, originalReleaseYear: year },
  offers: service ? [{ package: { technicalName: service.toLowerCase(), clearName: service }, standardWebURL: `https://www.${service.toLowerCase()}.com/title/${id}`, monetizationType: "FLATRATE" }] : [] });
const ranma = { title: "Ranma ½ (2024) 3rd Season", titles: ["らんま1/2 第3期", "Ranma 1/2 (2024) 3rd Season", "Ranma1/2 (2024) Season 3"], anilistFormat: "TV",
  anilistOffers: [{ service: "Netflix", url: "https://www.netflix.com/title/81171925" }] };
test("a year declared in the title selects the remake and never the older series", () => {
  const old = jwNode("ts20738", "Ranma ½", 1989, "Animebox");
  const remake = jwNode("ts438720", "Ranma ½", 2024, "Netflix");
  assert.equal(policy.findMatch(ranma, [old, remake]).id, "ts438720");
  assert.equal(policy.findMatch({ ...ranma, anilistOffers: [] }, [old, remake]).id, "ts438720");
  assert.equal(policy.findMatch(ranma, [old]), null);
  assert.ok(policy.searchTitles({ title: "Ranma1/2 (2024) Season 3" }).includes("Ranma1/2"));
});
test("same-title series without a declared year are resolved by the known platform", () => {
  const item = { title: "Sample Remake 2nd Season", anilistFormat: "TV", anilistOffers: [{ service: "Netflix", url: "https://www.netflix.com/title/1" }] };
  const old = jwNode("old", "Sample Remake", 1990, "Hulu");
  const remake = jwNode("new", "Sample Remake", 2024, "Netflix");
  assert.equal(policy.findMatch(item, [old, remake]).id, "new");
  assert.equal(policy.findMatch({ ...item, title: "Sample Remake", anilistOffers: item.anilistOffers }, [old, remake]).id, "new");
});
test("records from an older matching version are looked up again and their id is not reused", async () => {
  const previous = { status: "verified", offers, justwatchId: "ts20738", lookupVersion: 1, checkedAt: new Date(now).toISOString() };
  const stale = { ...payload, releases: payload.releases.map(item => ({ ...item, anilistOffers: [] })) };
  const seen = [];
  await enrichPlatforms(stale, { version: 1, series: { sample: { countries: { ES: previous, MX: previous } } } }, {
    now, countries: [es], lookup: async (item, country, options) => { seen.push(options.knownId); return { status: "verified", offers }; }
  });
  assert.deepEqual(seen, [null]);
  const known = [];
  const fetchImpl = async (url, options) => { known.push(JSON.parse(options.body).operationName); return new Response(JSON.stringify({ data: { popularTitles: { edges: [] } } }), { status: 200 }); };
  await lookupAvailability({ title: "Sample", anilistId: 1, anilistOffers: offers }, es, { previous, fetchImpl }).catch(() => {});
  assert.equal(known.includes("GetKnownTitle"), false);
});
test("a no-offers id from an older version is kept when the new search finds nothing", async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.operationName === "GetKnownTitle") return Response.json({ data: { node: { ...catalogNode("Renamed", "netflix", "kept"), offers: [] } } });
    return Response.json({ data: { popularTitles: { edges: [] } } });
  };
  const result = await lookupAvailability({ ...row, anilistOffers: offers }, es, { previous: { status: "no-offers", justwatchId: "kept", lookupVersion: 1 }, fetchImpl });
  assert.equal(result.status, "no-offers");
  assert.equal(result.justwatchId, "kept");
  const wrong = await lookupAvailability({ ...row, anilistOffers: offers }, es, { previous: { status: "verified", justwatchId: "wrong", offers, lookupVersion: 1 }, fetchImpl, aliasState: { unavailable: true } }).catch(error => error);
  assert.notEqual(wrong.justwatchId, "wrong");
});
