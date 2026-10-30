(function (root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.PlatformPolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const COUNTRIES = [
    { code: "ES", name: "España", lang: "es" }, { code: "MX", name: "México", lang: "es" },
    { code: "AR", name: "Argentina", lang: "es" }, { code: "CL", name: "Chile", lang: "es" },
    { code: "CO", name: "Colombia", lang: "es" }, { code: "US", name: "EE. UU.", lang: "en" },
    { code: "GB", name: "Reino Unido", lang: "en" }, { code: "DE", name: "Alemania", lang: "de" },
    { code: "FR", name: "Francia", lang: "fr" }, { code: "IT", name: "Italia", lang: "it" },
    { code: "BR", name: "Brasil", lang: "pt" }, { code: "PT", name: "Portugal", lang: "pt" }
  ];
  const PRIORITY = { Crunchyroll: 1, HIDIVE: 2, "Prime Video": 3, Netflix: 4, "Disney+": 5, Hulu: 6, Max: 7, "Apple TV+": 8 };
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const seriesKey = item => item.anilistId ? `anilist-${item.anilistId}` : normalize(item.animeKey || item.route || item.title);
  function httpsUrl(value) {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; }
    catch { return ""; }
  }
  function offerService(offer) {
    const pkg = offer.package || {};
    const technical = String(pkg.technicalName || "").toLowerCase();
    const known = { crunchyroll: "Crunchyroll", hidive: "HIDIVE", netflix: "Netflix", netflixbasicwithads: "Netflix", amazonprime: "Prime Video", amazonprimevideo: "Prime Video", disneyplus: "Disney+", hulu: "Hulu", max: "Max", hbomax: "Max", appletvplus: "Apple TV+" };
    // Add-on channels are distinct subscriptions; do not label them as Prime or Crunchyroll.
    return known[technical] || String(pkg.clearName || "").trim();
  }
  function allowedOffers(node) {
    const offers = new Map();
    for (const offer of node.offers || []) {
      const monetizationType = String(offer.monetizationType || "").toUpperCase();
      if (!["FLATRATE", "FREE", "ADS"].includes(monetizationType)) continue;
      const service = offerService(offer);
      const url = httpsUrl(offer.standardWebURL);
      if (service && url && !offers.has(service)) offers.set(service, { service, url, monetizationType });
    }
    return [...offers.values()].sort((a, b) => (PRIORITY[a.service] || 50) - (PRIORITY[b.service] || 50) || a.service.localeCompare(b.service));
  }
  function seriesTitle(value) {
    let title = String(value || "").trim();
    let previous;
    do {
      previous = title;
      title = title.replace(/\s+(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s+(?:season|cour)|(?:season|part|cour)\s+\d+)\s*$/i, "").trim();
    } while (title !== previous);
    return title;
  }
  function searchTitles(item) {
    const raw = [...new Set([item.anilistTitle, item.title, ...(item.titles || [])].filter(Boolean))];
    const roots = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? [] : raw.map(seriesTitle).filter((value, index) => value !== raw[index] && normalize(value).length >= 5);
    return [...new Set([...raw.slice(0, 2), ...roots.slice(0, 3)])];
  }
  function findMatch(item, nodes) {
    const raw = [item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean);
    const titles = new Set(raw.map(normalize));
    const type = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW";
    const candidates = nodes.filter(node => node.objectType === type);
    const unique = [...new Map(candidates.filter(node => titles.has(normalize(node.content?.title))).map(node => [node.id, node])).values()];
    const year = item.anilistYear || item.originalReleaseYear;
    if (year) {
      const byYear = unique.filter(node => Number(node.content?.originalReleaseYear) === Number(year));
      if (byYear.length === 1) return byYear[0];
    } else if (unique.length === 1) return unique[0];
    if (type === "MOVIE") return null;
    const roots = new Set(raw.map(seriesTitle).filter((value, index) => value !== raw[index] && normalize(value).length >= 5).map(normalize));
    // A sequel may be listed under the parent series, with its original premiere year.
    // Keep numbers within the title, remake years and spin-off names intact.
    const parents = [...new Map(candidates.filter(node => roots.has(normalize(node.content?.title))).map(node => [node.id, node])).values()];
    if (parents.length === 1) return parents[0];
    const available = parents.filter(node => allowedOffers(node).length > 0);
    return available.length === 1 ? available[0] : null;
  }
  function basePlatforms(item) {
    if (item.basePlatforms) return item.basePlatforms;
    // Migrate a previous device-local result without treating it as authoritative shared data.
    const legacy = item.jwVerified && item.jwSource !== "shared";
    const service = (legacy ? item.jwPreviousService : item.service) || "No legal platform";
    return { service, serviceUrl: (legacy ? item.jwPreviousServiceUrl : item.serviceUrl) || "",
      allServices: (legacy ? item.jwPreviousAllServices : item.allServices) || [],
      hasAllowedPlatform: service !== "No legal platform" };
  }
  function applyCountryPlatforms(item, country = "ES", now = Date.now()) {
    const base = basePlatforms(item);
    const record = item.platformsByCountry?.[country];
    const offers = record?.status === "verified" && Array.isArray(record.offers)
      ? record.offers.filter(offer => offer.service && httpsUrl(offer.url)) : [];
    const best = offers[0];
    // Global AnimeSchedule/AniList links are metadata, not regional availability.
    // Missing evidence must not turn a US/global service into a local watch link.
    return { ...item, service: "No legal platform", serviceUrl: "", allServices: [], hasAllowedPlatform: false, basePlatforms: base,
      ...(best ? { service: best.service, serviceUrl: best.url, allServices: offers.map(offer => offer.service), hasAllowedPlatform: true } : {}),
      jwVerified: Boolean(best), jwSource: "shared", jwCountry: country,
      jwVerifiedAt: record?.checkedAt || "",
      serviceUrls: Object.fromEntries(offers.map(offer => [offer.service, offer.url])),
      platformStatus: record?.status || "pending",
      platformStale: Boolean(record?.lastError) || Boolean(record?.checkedAt && now - Date.parse(record.checkedAt) > 24 * 3600000)
    };
  }
  return { COUNTRIES, seriesKey, searchTitles, findMatch, allowedOffers, basePlatforms, applyCountryPlatforms };
});
