(function (root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.PlatformPolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const COUNTRIES = [{ code: "ES", name: "España", lang: "es" }];
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
      title = title.replace(/\s*[-–—]?\s*(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s+(?:season|cour)|(?:season|part|cour)\s+\d+|第[0-9一二三四五六七八九十]+期)\s*[-–—]?\s*$/i, "").trim();
      title = title.replace(/\s+(?:(?:\d+(?:st|nd|rd|th)\s*(?:-\s*\d+(?:st|nd|rd|th))?\s+stage)|act\s+(?:[IVX]+|\d+))$/i, "").trim();
      title = title.replace(/\s+(?:II|III|IV|V|VI)$/i, "").trim();
    } while (title !== previous);
    return title;
  }
  function validSeriesRoot(value) {
    const key = normalize(value);
    return key.length >= 5 || (key.length >= 2 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(key));
  }
  const DECLARED_YEAR = /\s*\(((?:19|20)\d{2})\)/;
  const withoutYear = value => String(value || "").replace(DECLARED_YEAR, "").trim();
  function subtitleRoot(value) {
    return seriesTitle(String(value || "").split(/: | - | ~ /)[0]);
  }
  function searchTitles(item) {
    const raw = [...new Set([item.anilistTitle, item.title, ...(item.titles || [])].filter(Boolean))];
    const roots = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? [] : [...raw.map(seriesTitle), ...raw.map(value => seriesTitle(withoutYear(value))), ...raw.map(subtitleRoot)].filter(value => !raw.includes(value) && validSeriesRoot(value));
    return [...new Set([...raw.slice(0, 2), ...roots])].slice(0, 6);
  }
  function findMatch(item, nodes) {
    const matchKey = value => normalize(String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/&/g, "and")).replace(/ou/g, "o").replace(/uu/g, "u").replace(/jyo/g, "jo").replace(/jyu/g, "ju").replace(/syo/g, "sho").replace(/syu/g, "shu").replace(/tyo/g, "cho").replace(/tyu/g, "chu");
    const raw = [item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean);
    const titles = new Set(raw.map(matchKey));
    const type = String(item.anilistFormat || item.format).toUpperCase() === "MOVIE" ? "MOVIE" : "SHOW";
    // A title such as "Ranma ½ (2024)" names a remake: an older series with the same name is another show.
    const declaredYear = raw.map(value => value.match(DECLARED_YEAR)?.[1]).find(Boolean);
    const candidates = nodes.filter(node => node.objectType === type &&
      (!declaredYear || Number(node.content?.originalReleaseYear) === Number(declaredYear)));
    const services = new Set([...(item.anilistOffers || []).map(offer => offer.service), ...(basePlatforms(item).allServices || [])]);
    const sharesService = node => allowedOffers(node).some(offer => services.has(offer.service));
    const matchesTitle = (node, names) => [node.content?.title, node.content?.originalTitle].some(title => title && names.has(matchKey(title)));
    const dedupe = values => [...new Map(values.map(node => [node.id, node])).values()];
    const year = item.anilistYear || item.originalReleaseYear;
    const selectExact = values => {
      const matching = year ? values.filter(node => Number(node.content?.originalReleaseYear) === Number(year)) : values;
      return matching.length === 1 ? matching[0] : null;
    };
    const exactNodes = dedupe(candidates.filter(node => matchesTitle(node, titles)));
    const exact = selectExact(exactNodes);
    if (exact) return exact;
    const exactShared = exactNodes.filter(sharesService);
    if (exactShared.length === 1) return exactShared[0];
    const wordKey = value => {
      const words = [...new Set((type === "MOVIE" ? String(value || "") : seriesTitle(value)).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
      return words.length >= 3 ? words.sort().join(" ") : "";
    };
    const wordTitles = new Set(raw.map(wordKey).filter(Boolean));
    const reordered = dedupe(candidates.filter(node => [node.content?.title, node.content?.originalTitle]
      .some(title => title && wordTitles.has(wordKey(title)))));
    if (reordered.length === 1) {
      const match = selectExact(reordered);
      if (match) return match;
    }
    if (type === "MOVIE") return null;
    const roots = new Set(raw.map(value => seriesTitle(withoutYear(value))).filter((value, index) => value !== raw[index] && validSeriesRoot(value)).map(matchKey));
    // A sequel may be listed under the parent series, with its original premiere year.
    // Keep numbers within the title, remake years and spin-off names intact.
    const parents = [...new Map(candidates.filter(node => matchesTitle(node, roots)).map(node => [node.id, node])).values()];
    if (parents.length === 1) return parents[0];
    const parentsShared = parents.filter(sharesService);
    if (parentsShared.length === 1) return parentsShared[0];
    const available = parents.filter(node => allowedOffers(node).length > 0);
    if (available.length === 1) return available[0];
    const subtitleRoots = new Set(raw.map(subtitleRoot).filter((value, index) => value !== raw[index] && validSeriesRoot(value)).map(matchKey));
    const corroborated = dedupe(candidates.filter(node => matchesTitle(node, subtitleRoots) && sharesService(node)));
    return corroborated.length === 1 ? corroborated[0] : null;
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
  function anilistOffers(media) {
    const candidates = [
      ...(media.externalLinks || []).filter(link => String(link.type || "").toUpperCase() === "STREAMING"),
      ...(media.streamingEpisodes || [])
    ];
    const result = new Map();
    for (const link of candidates) {
      const name = String(link.site || "").trim();
      const service = ({ "Amazon Prime Video": "Prime Video", "Disney Plus": "Disney+" })[name] || name;
      const url = httpsUrl(link.url);
      if (service && url && !result.has(service)) result.set(service, { service, url });
    }
    return [...result.values()].sort((a, b) => (PRIORITY[a.service] || 50) - (PRIORITY[b.service] || 50));
  }
  const FALLBACK_DOMAINS = {
    crunchyroll: ["crunchyroll.com"], hidive: ["hidive.com"], netflix: ["netflix.com"],
    disney: ["disneyplus.com"], disneyplus: ["disneyplus.com"], hulu: ["hulu.com"], max: ["max.com", "hbomax.com"],
    primevideo: ["primevideo.com", ...["com", "es", "de", "fr", "it", "co.uk", "co.jp", "com.mx", "com.br"].map(tld => `amazon.${tld}`)],
    appletv: ["tv.apple.com", "apple.co"], youtube: ["youtube.com", "youtu.be"],
    bilibili: ["bilibili.tv", "bilibili.com"], bilibilitv: ["bilibili.tv", "bilibili.com"],
    iq: ["iq.com"], iqiyi: ["iqiyi.com"], oceanveil: ["oceanveil.net"], tubitv: ["tubitv.com"],
    crackle: ["crackle.com"], tencentvideo: ["v.qq.com"], wetv: ["wetv.vip"]
  };
  function validFallbackOffer(offer) {
    const url = httpsUrl(offer.url);
    if (!offer.service || !url) return false;
    const serviceKey = normalize(offer.service);
    const domains = Object.hasOwn(FALLBACK_DOMAINS, serviceKey) ? FALLBACK_DOMAINS[serviceKey] : null;
    const host = new URL(url).hostname;
    return !domains || domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  }
  function applyCountryPlatforms(item, country = "ES", now = Date.now()) {
    const base = basePlatforms(item);
    const record = item.platformsByCountry?.[country];
    const offers = record?.status === "verified" && Array.isArray(record.offers)
      ? record.offers.filter(offer => offer.service && httpsUrl(offer.url)) : [];
    const useAnilist = !offers.length && (!record || ["not-found", "pending", "error", "no-offers"].includes(record.status));
    const fallback = useAnilist && Array.isArray(item.anilistOffers)
      ? item.anilistOffers.filter(validFallbackOffer) : [];
    const baseUrl = httpsUrl(base.serviceUrl);
    const scheduleOffers = base.service && base.service !== "No legal platform" && validFallbackOffer({ service: base.service, url: baseUrl })
      ? [{ service: base.service, url: baseUrl }] : [];
    const visibleOffers = offers.length ? offers : fallback.length ? fallback : scheduleOffers;
    const best = visibleOffers[0];
    return { ...item, service: "No legal platform", serviceUrl: "", allServices: [], hasAllowedPlatform: false, basePlatforms: base,
      ...(best ? { service: best.service, serviceUrl: best.url, allServices: visibleOffers.map(offer => offer.service), hasAllowedPlatform: true } : {}),
      platformSource: offers.length ? "justwatch" : fallback.length ? "anilist" : scheduleOffers.length ? "animeschedule" : "",
      jwVerified: Boolean(offers.length), jwSource: "shared", jwCountry: country,
      jwVerifiedAt: record?.checkedAt || "",
      serviceUrls: Object.fromEntries(visibleOffers.map(offer => [offer.service, offer.url])),
      platformStatus: record?.status || "pending",
      platformStale: Boolean(record?.lastError || record?.pendingNegative) || Boolean(record?.checkedAt && now - Date.parse(record.checkedAt) > 24 * 3600000)
    };
  }
  return { COUNTRIES, seriesKey, searchTitles, findMatch, allowedOffers, anilistOffers, basePlatforms, applyCountryPlatforms };
});
