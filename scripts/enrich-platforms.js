"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const policy = require("../platform-policy");
const { validate, isPending } = require("../schedule-policy");
const ENDPOINT = "https://apis.justwatch.com/graphql";
const SEARCH = `query GetSearch($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!, $offerFilter: OfferFilter!) {
  popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR, sortRandomSeed: 0) {
    edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear }
      offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType }
    } }
  }
}`;

async function lookupAvailability(item, country, { fetchImpl = fetch, signal } = {}) {
  const titles = [...new Set([item.anilistTitle, item.title, ...(item.titles || [])].filter(Boolean))].slice(0, 3);
  for (const searchQuery of titles) {
    const response = await fetchImpl(ENDPOINT, { method: "POST", signal: signal || AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ operationName: "GetSearch", query: SEARCH, variables: {
        first: 20, country: country.code, language: country.lang,
        filter: { searchQuery, objectTypes: [String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW"] },
        offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] }
      } })
    });
    if (!response.ok) {
      const error = new Error(`JustWatch HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
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

async function enrichPlatforms(payload, cache = { version: 1, series: {} }, {
  countries = policy.COUNTRIES, lookup = lookupAvailability, now = Date.now(),
  budgetMs = 240000, concurrency = 3, ttlMs = 12 * 3600000
} = {}) {
  const rows = validate(payload);
  cache = { version: 1, series: { ...(cache.series || {}) } };
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
      const fresh = previous?.checkedAt && now - Date.parse(previous.checkedAt) < ttlMs;
      const retryLater = previous?.lastError && now - lastAttempt < 3600000;
      if ((!fresh || previous?.lastError) && !retryLater) tasks.push({ key, row, country, lastAttempt });
    }
  }
  tasks.sort((a, b) => a.lastAttempt - b.lastAttempt ||
    Number(b.country.code === "ES") - Number(a.country.code === "ES") || a.key.localeCompare(b.key) || a.country.code.localeCompare(b.country.code));
  let cursor = 0, checked = 0, errors = 0, rateLimited = false;
  const deadline = Date.now() + budgetMs;
  const timestamp = new Date(now).toISOString();
  async function worker() {
    while (cursor < tasks.length && Date.now() < deadline && !rateLimited) {
      const { key, row, country } = tasks[cursor++];
      const previous = cache.series[key].countries[country.code];
      try {
        const result = await lookup(row, country, { signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))) });
        if (!["verified", "no-offers", "not-found"].includes(result.status) || !Array.isArray(result.offers)) throw new Error("Registro de plataformas inválido");
        cache.series[key].countries[country.code] = { ...result, checkedAt: timestamp, lastAttemptAt: timestamp };
      } catch (error) {
        errors++;
        if (error.status === 429) rateLimited = true;
        cache.series[key].countries[country.code] = { ...(previous || { status: "error", offers: [] }), lastAttemptAt: timestamp,
          lastError: "No se pudo consultar JustWatch; se reintentará automáticamente." };
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
      stale: records.filter(record => record?.lastError || (record?.checkedAt && now - Date.parse(record.checkedAt) >= ttlMs)).length }];
  }));
  const summary = { checked, errors, queued: tasks.length - checked, rateLimited, coverage, countries: countries.map(country => country.code),
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
  await atomicWrite(cacheFile, result.cache);
  await atomicWrite(scheduleFile, result.payload);
  console.log(JSON.stringify(result.summary));
  if (result.summary.errors) console.warn("JustWatch incompleto: se conserva la última información válida y se reintentará en el siguiente cron.");
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { lookupAvailability, enrichPlatforms, main };
