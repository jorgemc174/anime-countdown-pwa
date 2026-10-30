"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const policy = require("../platform-policy");
const { validate, isPending } = require("../schedule-policy");
const LOOKUP_VERSION = 5;
const delay = require("node:timers/promises").setTimeout;
const ENDPOINT = "https://apis.justwatch.com/graphql";
const SEARCH = `query GetSearch($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!, $offerFilter: OfferFilter!) {
  popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR, sortRandomSeed: 0) {
    edges { node { id objectType content(country: $country, language: $language) { title originalTitle originalReleaseYear }
      offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType }
    } }
  }
}`;
const BY_ID = `query GetKnownTitle($id: ID!, $country: Country!, $language: Language!, $offerFilter: OfferFilter!) {
  node(id: $id) {
    ... on Show { id objectType content(country: $country, language: $language) { title originalTitle originalReleaseYear }
      offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType } }
    ... on Movie { id objectType content(country: $country, language: $language) { title originalTitle originalReleaseYear }
      offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType } }
  }
}`;
const NEGATIVE_RETRY_MS = 3 * 3600000;
function inputSignature(item) {
  return JSON.stringify([item.anilistFormat || item.format || "SHOW", item.anilistYear || null,
    [...new Set([item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean))].sort()]);
}

function providerError(response) {
  const error = new Error(`JustWatch HTTP ${response.status}`);
  error.status = response.status;
  const value = response.headers.get("retry-after");
  const seconds = value && /^\d+$/.test(value) ? Number(value) : null;
  const duration = seconds !== null ? seconds * 1000 : Math.max(0, Date.parse(value || "") - Date.now());
  error.retryAfterMs = Number.isFinite(duration) ? Math.min(duration, 24 * 3600000) : 0;
  return error;
}

async function lookupKnownTitle(item, country, { previous, knownId, fetchImpl = fetch, signal } = {}) {
  const id = previous?.justwatchId && ["verified", "no-offers"].includes(previous.status) ? previous.justwatchId : knownId;
  if (!id) return null;
  const response = await fetchImpl(ENDPOINT, { method: "POST", signal: signal || AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ operationName: "GetKnownTitle", query: BY_ID, variables: {
      id, country: country.code, language: country.lang,
      offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] }
    } })
  });
  if (!response.ok) throw providerError(response);
  const json = await response.json();
  if (json.errors?.length || !json.data || !("node" in json.data)) throw new Error("Respuesta de JustWatch inválida");
  const node = json.data.node;
  if (!node) return null;
  const type = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW";
  if (node.id !== id || node.objectType !== type || !Array.isArray(node.offers)) throw new Error("Identidad de JustWatch incoherente");
  const offers = policy.allowedOffers(node);
  return { status: offers.length ? "verified" : "no-offers", offers, justwatchId: node.id,
    matchedTitle: node.content?.title || previous?.matchedTitle, aliases: previous?.aliases || [] };
}

async function lookupJustWatch(item, country, { fetchImpl = fetch, signal } = {}) {
  const titles = policy.searchTitles(item);
  const languages = [...new Set([country.lang, "en"])];
  const attempts = titles.flatMap(searchQuery => languages.map(language => ({ searchQuery, language })));
  for (const { searchQuery, language } of attempts) {
    const response = await fetchImpl(ENDPOINT, { method: "POST", signal: signal || AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ operationName: "GetSearch", query: SEARCH, variables: {
        first: 20, country: country.code, language,
        filter: { searchQuery, objectTypes: [String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW"] },
        offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] }
      } })
    });
    if (!response.ok) throw providerError(response);
    const json = await response.json();
    if (json.errors?.length || !Array.isArray(json.data?.popularTitles?.edges)) throw new Error("Respuesta de JustWatch inválida");
    const nodes = json.data.popularTitles.edges.map(edge => edge.node).filter(Boolean);
    const node = policy.findMatch(item, nodes);
    if (!node) continue;
    const offers = policy.allowedOffers(node);
    return { status: offers.length ? "verified" : "no-offers", offers, justwatchId: node.id, matchedTitle: node.content.title };
  }
  return { status: "not-found", offers: [] };
}

async function resolveTitleAliases(item, { fetchImpl = fetch, signal } = {}) {
  const query = `query ResolveStreamingTitle($id: Int, $search: String) {
    Media(id: $id, search: $search, type: ANIME) {
      id title { romaji english native } synonyms
    }
  }`;
  const id = Number(item.anilistId) || null;
  const response = await fetchImpl("https://graphql.anilist.co", {
    method: "POST", signal: signal || AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables: { id, search: id ? null : item.title } })
  });
  if (!response.ok) {
    const error = new Error(`AniList HTTP ${response.status} al resolver nombres`);
    error.provider = "AniList"; error.status = response.status; throw error;
  }
  const json = await response.json();
  if (json.errors?.some(error => error.status !== 404)) throw new Error("No se pudieron consultar los nombres de AniList");
  const media = json.data?.Media;
  if (!media) return null;
  const titles = [...new Set([media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms || [])].filter(Boolean))];
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const expected = [item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean).map(normalize);
  if (id ? Number(media.id) !== id : !titles.some(title => expected.includes(normalize(title)))) return null;
  return { english: media.title?.english, titles };
}

async function lookupAvailability(item, country, options = {}) {
  const known = await lookupKnownTitle(item, country, options);
  if (known) return known;
  const direct = await lookupJustWatch(item, country, options);
  if (direct.status !== "not-found") return direct;
  const key = policy.seriesKey(item);
  const aliasCache = options.aliasCache || new Map();
  if (options.aliasState?.unavailable) { const error = new Error("Resolución de nombres temporalmente no disponible"); error.provider = "AniList"; throw error; }
  if (!aliasCache.has(key)) aliasCache.set(key, resolveTitleAliases(item, options));
  let aliases;
  try { aliases = await aliasCache.get(key); }
  catch (error) { error.provider = "AniList"; throw error; }
  if (!aliases) return direct;
  const enriched = { ...item, anilistTitle: aliases.english || item.anilistTitle,
    titles: [...new Set([...(item.titles || []), ...aliases.titles])] };
  const result = await lookupJustWatch(enriched, country, options);
  return { ...result, aliases: aliases.titles };
}

function mergeResult(previous, result, timestamp) {
  const negative = result.status !== "verified" || result.offers.length === 0;
  if (previous?.status === "verified" && previous.offers?.length && negative) {
    const firstSeenAt = previous.pendingNegative?.firstSeenAt || timestamp;
    if (Date.parse(timestamp) - Date.parse(firstSeenAt) < NEGATIVE_RETRY_MS) {
      return { ...previous, lastAttemptAt: timestamp, lastError: undefined, errorProvider: undefined,
        pendingNegative: { status: result.status, firstSeenAt }, nextRetryAt: new Date(Date.parse(firstSeenAt) + NEGATIVE_RETRY_MS).toISOString() };
    }
  }
  return { ...result, lookupVersion: LOOKUP_VERSION, checkedAt: timestamp, lastAttemptAt: timestamp };
}

async function enrichPlatforms(payload, cache = { version: 1, series: {} }, {
  countries = policy.COUNTRIES, lookup = lookupAvailability, now = Date.now(),
  budgetMs = 240000, concurrency = 3, ttlMs = 12 * 3600000
} = {}) {
  const rows = validate(payload);
  let nextRequestAt = 0;
  const aliasCache = new Map();
  const aliasState = { unavailable: Date.parse(cache.cooldowns?.AniList || "") > now };
  const throttledFetch = async (url, options) => {
    const start = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = start + 1300;
    if (start > Date.now()) await delay(start - Date.now(), undefined, { signal: options.signal });
    return fetch(url, options);
  };
  const priorSeries = cache.series || {};
  cache = { version: 1, series: { ...priorSeries }, cooldowns: { ...cache.cooldowns } };
  const series = new Map();
  for (const row of rows) {
    if (row.scheduleStatus === "cancelled" || (!isPending(row) && Date.parse(row.releaseDate) < now - 7 * 86400000)) continue;
    const key = policy.seriesKey(row);
    if (!series.has(key)) series.set(key, row);
    else series.set(key, { ...row, ...series.get(key), titles: [...new Set([...(series.get(key).titles || []), ...(row.titles || [])])] });
  }
  const tasks = [];
  for (const [key, row] of series) {
    cache.series[key] = { ...cache.series[key], title: row.title, countries: { ...cache.series[key]?.countries } };
    for (const country of countries) {
      const previous = cache.series[key].countries[country.code];
      const lastAttempt = Date.parse(previous?.lastAttemptAt || previous?.checkedAt || "") || 0;
      const target = { ...row, titles: [...new Set([...(row.titles || []), ...(cache.series[key].aliases || [])])] };
      const changedNames = previous?.inputSignature && previous.inputSignature !== inputSignature(target);
      const lifespan = previous?.status === "verified" ? ttlMs : NEGATIVE_RETRY_MS;
      const fresh = !changedNames && !previous?.pendingNegative && previous?.checkedAt &&
        (previous.status === "verified" || previous.lookupVersion === LOOKUP_VERSION) && now - Date.parse(previous.checkedAt) < lifespan;
      const retryLater = previous?.nextRetryAt ? now < Date.parse(previous.nextRetryAt) : previous?.lastError && now - lastAttempt < 3600000;
      if ((!fresh || previous?.lastError) && (!retryLater || changedNames)) tasks.push({ key, row, country, lastAttempt });
    }
  }
  tasks.sort((a, b) => Number(b.country.code === "ES") - Number(a.country.code === "ES") ||
    a.lastAttempt - b.lastAttempt || a.key.localeCompare(b.key) || a.country.code.localeCompare(b.country.code));
  let cursor = 0, checked = 0, errors = 0, rateLimited = Date.parse(cache.cooldowns.JustWatch || "") > now;
  const deadline = Date.now() + budgetMs;
  const timestamp = new Date(now).toISOString();
  async function worker() {
    while (cursor < tasks.length && Date.now() < deadline && !rateLimited) {
      const { key, row, country } = tasks[cursor++];
      const previous = cache.series[key].countries[country.code];
      try {
        const target = { ...row, titles: [...new Set([...(row.titles || []), ...(cache.series[key].aliases || [])])] };
        const knownIds = [...new Set(Object.values(cache.series[key].countries).filter(record => record.status === "verified").map(record => record.justwatchId).filter(Boolean))];
        const result = await lookup(target, country, { previous, knownId: knownIds.length === 1 ? knownIds[0] : null, aliasCache, aliasState, signal: AbortSignal.timeout(Math.max(1, Math.min(45000, deadline - Date.now()))), fetchImpl: throttledFetch });
        if (!["verified", "no-offers", "not-found"].includes(result.status) || !Array.isArray(result.offers)) throw new Error("Registro de plataformas inválido");
        cache.series[key].aliases = [...new Set([...(cache.series[key].aliases || []), row.title, row.anilistTitle,
          ...(row.titles || []), ...(result.aliases || []), result.matchedTitle].filter(Boolean))];
        const signature = inputSignature({ ...row, titles: [...new Set([...(row.titles || []), ...cache.series[key].aliases])] });
        cache.series[key].countries[country.code] = { ...mergeResult(previous, result, timestamp), inputSignature: signature };
      } catch (error) {
        errors++;
        if (error.provider === "AniList" && [403, 429].includes(error.status)) { aliasState.unavailable = true; cache.cooldowns.AniList = new Date(now + 3600000).toISOString(); }
        if (error.status === 429 && error.provider !== "AniList") { rateLimited = true; cache.cooldowns.JustWatch = new Date(now + Math.max(15 * 60000, error.retryAfterMs || 0)).toISOString(); }
        cache.series[key].countries[country.code] = { ...(previous || { status: "error", offers: [] }), lastAttemptAt: timestamp,
          lastError: error.provider === "AniList" ? "No se pudieron resolver los nombres; se reintentará automáticamente." : "No se pudo consultar JustWatch; se reintentará automáticamente.",
          errorProvider: error.provider || "JustWatch",
          consecutiveErrors: (previous?.consecutiveErrors || 0) + 1,
          nextRetryAt: new Date(now + Math.max(error.retryAfterMs || 0, Math.min(6 * 3600000, 15 * 60000 * 2 ** Math.min(previous?.consecutiveErrors || 0, 5)))).toISOString() };
      }
      checked++;
      if (cursor < tasks.length && !rateLimited) await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  // Keep cache entries for temporarily absent shows, but expire unused ones after 180 days.
  for (const [key, entry] of Object.entries(cache.series)) {
    if (series.has(key)) { entry.lastSeenAt = timestamp; continue; }
    if (now - Date.parse(entry.lastSeenAt || "1970-01-01") > 180 * 86400000) delete cache.series[key];
  }
  const enriched = rows.map(row => {
    const records = cache.series[policy.seriesKey(row)]?.countries || {};
    return policy.applyCountryPlatforms({ ...row, basePlatforms: policy.basePlatforms(row), platformsByCountry: records }, "ES", now);
  });
  const coverage = Object.fromEntries(countries.map(country => {
    const records = [...series.keys()].map(key => cache.series[key].countries[country.code]);
    return [country.code, { total: records.length, verified: records.filter(record => record?.status === "verified").length,
      pending: records.filter(record => !record?.checkedAt).length,
      stale: records.filter(record => record?.lastError || record?.pendingNegative || (record?.checkedAt && now - Date.parse(record.checkedAt) >= ttlMs)).length }];
  }));
  const issues = [];
  for (const [key, row] of series) for (const country of countries) {
    const record = cache.series[key].countries[country.code];
    const before = priorSeries[key]?.countries?.[country.code];
    let reason = record?.pendingNegative ? "availability-change-needs-confirmation" :
      before?.status === "verified" && record?.status !== "verified" ? "confirmed-availability-removed" :
      record?.lastError ? "lookup-error" : !record?.checkedAt ? "not-checked" :
      record?.status === "not-found" && policy.basePlatforms(row).hasAllowedPlatform ? "unresolved-title-with-source-platform" : "";
    if (reason) issues.push({ key, title: row.title, country: country.code, reason, status: record?.status || "pending",
      errorProvider: record?.errorProvider || null, lastAttemptAt: record?.lastAttemptAt || null });
  }
  const summary = { checked, errors, issues, totalFailure: checked > 0 && errors === checked, queued: tasks.length - checked, rateLimited, coverage, countries: countries.map(country => country.code),
    source: "JustWatch", checkedAt: timestamp, series: series.size };
  return { payload: { ...payload, releases: enriched, platforms: summary }, cache, summary };
}

async function atomicWrite(filename, data) {
  await fs.writeFile(`${filename}.tmp`, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(`${filename}.tmp`, filename);
}
async function main() {
  const root = path.resolve(__dirname, "..");
  const scheduleFile = path.join(root, "schedule.json");
  const cacheFile = path.join(root, "platform-cache.json");
  const payload = JSON.parse(await fs.readFile(scheduleFile, "utf8"));
  let cache;
  try { cache = JSON.parse(await fs.readFile(cacheFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const configured = process.env.JUSTWATCH_COUNTRIES?.split(",").map(code => code.trim().toUpperCase());
  if (configured?.some(code => !policy.COUNTRIES.some(country => country.code === code))) throw new Error("País JustWatch no soportado");
  const result = await enrichPlatforms(payload, cache, {
    countries: configured ? policy.COUNTRIES.filter(country => configured.includes(country.code)) : policy.COUNTRIES
  });
  await atomicWrite(path.join(process.env.RUNNER_TEMP || require("node:os").tmpdir(), "anime-platform-audit.json"), result.summary);
  await atomicWrite(cacheFile, result.cache);
  await atomicWrite(scheduleFile, result.payload);
  console.log(JSON.stringify(result.summary));
  if (result.summary.totalFailure) process.exitCode = 1;
  if (result.summary.errors) console.warn("JustWatch incompleto: se conserva la última información válida y se reintentará en el siguiente cron.");
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { lookupAvailability, enrichPlatforms, main };
