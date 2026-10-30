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
  function findMatch(item, nodes) {
    const titles = new Set([item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean).map(normalize));
    const type = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW";
    const matches = nodes.filter(node => node.objectType === type && titles.has(normalize(node.content?.title)));
    const unique = [...new Map(matches.map(node => [node.id, node])).values()];
    const year = item.anilistYear || item.originalReleaseYear;
    const byYear = year ? unique.filter(node => Number(node.content?.originalReleaseYear) === Number(year)) : [];
    if (year) return byYear.length === 1 ? byYear[0] : null;
    return unique.length === 1 ? unique[0] : null;
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
    return { ...item, ...base, basePlatforms: base,
      ...(best ? { service: best.service, serviceUrl: best.url, allServices: offers.map(offer => offer.service), hasAllowedPlatform: true } : {}),
      jwVerified: Boolean(best), jwSource: "shared", jwCountry: country,
      jwVerifiedAt: record?.checkedAt || "",
      serviceUrls: Object.fromEntries(offers.map(offer => [offer.service, offer.url])),
      platformStatus: record?.status || "pending",
      platformStale: Boolean(record?.lastError) || Boolean(record?.checkedAt && now - Date.parse(record.checkedAt) > 24 * 3600000)
    };
  }
  return { COUNTRIES, seriesKey, findMatch, allowedOffers, basePlatforms, applyCountryPlatforms };
});
