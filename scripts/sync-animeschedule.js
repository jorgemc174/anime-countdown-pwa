"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = process.env.ANIMESCHEDULE_API_BASE || "https://animeschedule.net/api/v3";
const ANILIST_API = "https://graphql.anilist.co";
const IMAGE_BASE = "https://img.animeschedule.net/production/assets/public/img/";
const OUT_FILE = path.resolve(__dirname, "..", "schedule.json");
const SERVICE_PRIORITY = {
  Crunchyroll: 1, Funimation: 2, HIDIVE: 3,
  "Prime Video": 4, Netflix: 5, "Disney+": 6,
  Hulu: 7, Max: 8, "Apple TV+": 9,
  "Paramount+": 10, Peacock: 11, VRV: 12,
  Wakanim: 13, Bilibili: 14, Aniplus: 15,
  "Muse Asia": 16, "Ani-One": 17, Tubi: 18,
  "No legal platform": 99
};
const ANILIST_REQUEST_DELAY_MS = Number(process.env.ANILIST_REQUEST_DELAY_MS || "250");
const ANILIST_AIRING_MAX_PAGES = Number(process.env.ANILIST_AIRING_MAX_PAGES || process.env.ANILIST_CATALOG_MAX_PAGES || "20");
const ANILIST_SEASON_MAX_PAGES = Number(process.env.ANILIST_SEASON_MAX_PAGES || "5");

async function main() {
  const token = process.env.ANIMESCHEDULE_TOKEN;
  const timezone = process.env.SYNC_TIMEZONE || "Europe/Madrid";
  const weeks = Number(process.env.SYNC_WEEKS || "14");
  const rawItems = [];
  let successfulWeeks = 0;
  let authenticationFailed = false;

  if (!token) {
    throw new Error("ANIMESCHEDULE_TOKEN no configurado; no se genera una agenda con horas de AniList.");
  }

  for (const week of getNextWeeks(weeks)) {
    const response = await fetchAnimeScheduleWeekWithRetry(week, timezone, token);
    if (!response) {
      console.warn(`No se pudo leer ${week.year} semana ${week.week}; se continua con el resto.`);
      continue;
    }
    if (response.status === 404) {
      console.warn(`Sin datos para ${week.year} semana ${week.week}`);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      console.warn(`AnimeSchedule ${response.status} en ${week.year} semana ${week.week}: ${body.slice(0, 200)}`);
      if (response.status === 401 || response.status === 403) authenticationFailed = true;
      continue;
    }

    try {
      const data = await response.json();
      successfulWeeks++;
      rawItems.push(...extractArray(data));
    } catch (error) {
      console.warn(`AnimeSchedule devolvio JSON invalido en ${week.year} semana ${week.week}: ${error.message || error}`);
    }
  }

  if (authenticationFailed) {
    throw new Error("ANIMESCHEDULE_TOKEN fue rechazado (401/403). Actualiza el secreto de GitHub Actions.");
  }

  const minimumWeeks = Math.max(1, Math.ceil(getNextWeeks(weeks).length / 2));
  if (successfulWeeks < minimumWeeks && await hasUsableExistingSchedule()) {
    console.warn(`Solo respondieron ${successfulWeeks} semanas de ${weeks}; se conserva la agenda anterior y se reintentara despues.`);
    return;
  }

  // AnimeSchedule and AniList are the only sources allowed to create releases.
  // Never invent a weekly follow-up: the latest episode may have been the finale.
  const normalized = normalizeSchedule(rawItems, timezone);
  const shouldEnrichWithAnilist = process.env.ANILIST_VERIFY === "true";
  let releases = [];
  if (normalized.length) {
    releases = shouldEnrichWithAnilist
      ? await applyAnilistCorrections(normalized, timezone)
      : normalized;
  }
  let source = shouldEnrichWithAnilist ? "AnimeSchedule+AniList" : "AnimeSchedule";

  if (releases.length && process.env.INCLUDE_ANILIST_MISSING !== "false") {
    try {
      const result = await enrichAndAppendAnilistReleases(releases, timezone);
      releases = result.releases;
      if (result.matched || result.added) source = "AnimeSchedule+AniList";
    } catch (error) {
      // AniList is useful enrichment, but a temporary outage must not discard a
      // perfectly valid AnimeSchedule response or produce a failed cron email.
      console.warn(`AniList no disponible; se conserva AnimeSchedule: ${error.message || error}`);
      const preserved = await preserveExistingEnrichment(releases);
      releases = preserved.releases;
      if (preserved.usedAniList) source = "AnimeSchedule+AniList";
    }
  }

  if (!releases.length && process.env.ALLOW_ANILIST_FALLBACK === "true") {
    console.warn("AnimeSchedule no devolvio episodios validos; generando schedule.json desde AniList por ALLOW_ANILIST_FALLBACK=true.");
    releases = await fetchPublicAnilistSchedule();
    source = "AniList";
  }

  if (!releases.length) {
    if (await hasUsableExistingSchedule()) {
      console.warn("Las fuentes no devolvieron episodios validos; se conserva el ultimo schedule.json para reintentar en la proxima ejecucion.");
      return;
    }
    throw new Error("No se pudo generar schedule.json y no existe una agenda anterior valida.");
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    timezone,
    source,
    releases
  };

  if (await scheduleDataIsUnchanged(payload)) {
    console.log("schedule.json no tiene cambios de episodios o plataformas; no se crea un despliegue nuevo.");
    return;
  }

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`schedule.json actualizado: ${releases.length} episodios (${rawItems.length} items leidos, fuente ${source}).`);
}

async function readExistingSchedule() {
  try {
    return JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

async function hasUsableExistingSchedule() {
  const current = await readExistingSchedule();
  return Array.isArray(current?.releases) && current.releases.length > 0;
}

async function scheduleDataIsUnchanged(next) {
  const current = await readExistingSchedule();
  if (!Array.isArray(current?.releases)) return false;
  return current.timezone === next.timezone &&
    current.source === next.source &&
    JSON.stringify(current.releases) === JSON.stringify(next.releases);
}

async function preserveExistingEnrichment(baseReleases) {
  const current = await readExistingSchedule();
  if (!Array.isArray(current?.releases)) return { releases: baseReleases, usedAniList: false };

  let usedAniList = false;
  const enriched = baseReleases.map((item) => {
    const existing = current.releases.find((candidate) => getEpisodeKey(candidate) === getEpisodeKey(item));
    if (!existing) return item;
    if (existing.anilistId || existing.anilistTitle || existing.anilistScore != null) usedAniList = true;
    const keepExistingPlatform = !item.hasAllowedPlatform && existing.hasAllowedPlatform;
    return {
      ...item,
      anilistId: existing.anilistId || item.anilistId,
      anilistTitle: existing.anilistTitle || item.anilistTitle,
      anilistUrl: existing.anilistUrl || item.anilistUrl,
      anilistFormat: existing.anilistFormat || item.anilistFormat,
      anilistScore: existing.anilistScore ?? item.anilistScore,
      titles: existing.titles?.length ? existing.titles : (item.titles || []),
      coverUrl: item.coverUrl || existing.coverUrl,
      ...(keepExistingPlatform ? {
        service: existing.service,
        serviceUrl: existing.serviceUrl,
        allServices: existing.allServices || [existing.service],
        hasAllowedPlatform: true
      } : {})
    };
  });

  const carried = current.releases.filter((item) =>
    item.source === "anilist-missing" &&
    Number.isFinite(Date.parse(item.releaseDate || "")) &&
    Date.parse(item.releaseDate) > Date.now()
  );
  if (carried.length) usedAniList = true;
  return {
    releases: dedupeByEpisode(enriched.concat(carried)).sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate)),
    usedAniList
  };
}

async function applyAnilistCorrections(releases, timeZone) {
  const byAnime = new Map();
  for (const release of releases) {
    const key = release.animeKey || stableId(release.title);
    if (!byAnime.has(key)) byAnime.set(key, []);
    byAnime.get(key).push(release);
  }

  let corrected = 0;
  const out = [];
  for (const group of byAnime.values()) {
    const sample = group[0];
    const media = await findAnilistMedia(sample).catch((error) => {
      console.warn(`AniList no disponible para "${sample.title}": ${error.message || error}`);
      return null;
    });
    await wait(ANILIST_REQUEST_DELAY_MS);

    for (const release of group) {
      const next = media?.nextAiringEpisode;
      const releaseEpisode = parseEpisodeNumber(release.episodeNumber || release.episode);
      const nextEpisode = Number(next?.episode);
      const strongTitleMatch = media ? getAnilistReleaseMatchScore(release, media) >= 0.9 : false;
      if (String(media?.format || "").toUpperCase() === "MOVIE" && releaseEpisode === 1 && strongTitleMatch) {
        corrected++;
        continue;
      }
      const canCorrectEpisode = Number.isFinite(releaseEpisode) && Number.isFinite(nextEpisode) &&
        releaseEpisode === 1 && nextEpisode > 1 && strongTitleMatch;
      if (!media || (!canCorrectEpisode && !media.id)) {
        out.push(release);
        continue;
      }

      corrected++;
      out.push({
        ...release,
        ...(canCorrectEpisode ? { episode: `Ep ${nextEpisode}`, episodeNumber: String(nextEpisode) } : {}),
        anilistId: media.id,
        anilistTitle: media.title?.romaji || media.title?.english || release.title,
        anilistUrl: media.siteUrl || "",
        coverUrl: media.coverImage?.large || media.coverImage?.medium || release.coverUrl,
        correctedByAniList: canCorrectEpisode || undefined
      });
    }
  }

  console.log(`AniList verifico ${byAnime.size} series; correcciones aplicadas: ${corrected}.`);
  return out.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
}

async function findAnilistMedia(release) {
  const candidates = await searchAnilist(release.title);
  if (!candidates.length) return null;

  const titles = [release.title, release.route, release.animeKey].filter(Boolean);
  let best = null;
  let bestScore = 0;

  for (const media of candidates) {
    const mediaTitles = [
      media.title?.romaji,
      media.title?.english,
      media.title?.native,
      ...(media.synonyms || [])
    ].filter(Boolean);

    const score = Math.max(...titles.flatMap((title) => mediaTitles.map((mediaTitle) => titleSimilarityScore(title, mediaTitle))));
    if (score > bestScore) {
      bestScore = score;
      best = media;
    }
  }

  return bestScore >= 0.62 ? best : null;
}

function getAnilistReleaseMatchScore(release, media) {
  const releaseTitles = [release.title, release.route, release.animeKey].filter(Boolean);
  const mediaTitles = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || [])
  ].filter(Boolean);
  let best = 0;
  for (const left of releaseTitles) for (const right of mediaTitles) best = Math.max(best, titleSimilarityScore(left, right));
  return best;
}

async function searchAnilist(search) {
  const query = `query ($search: String) {
    Page(page: 1, perPage: 5) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        title { romaji english native }
        synonyms
        format
        coverImage { large medium }
        siteUrl
        nextAiringEpisode { episode airingAt }
      }
    }
  }`;

  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ query, variables: { search } })
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn(`AniList ${response.status} para "${search}": ${body.slice(0, 120)}`);
    return [];
  }

  const json = await response.json();
  if (json.errors?.length) {
    console.warn(`AniList error para "${search}": ${json.errors[0].message}`);
    return [];
  }

  return json.data?.Page?.media || [];
}

async function fetchPublicAnilistSchedule() {
  const releases = [];
  const seen = new Set();
  const now = Math.floor(Date.now() / 1000);

  const appendMedia = (media) => {
    if (!media?.anilistId || seen.has(media.anilistId)) return;
    if (!Number.isFinite(Date.parse(media.releaseDate || ""))) return;
    if (!isSchedulableItem(media)) return;
    if (!isSeasonalSeriesItem(media)) return;
    seen.add(media.anilistId);
    releases.push(mapPublicAnilistRelease(media));
  };

  for (let page = 1; page <= ANILIST_AIRING_MAX_PAGES; page++) {
    const chunk = await fetchAnilistAiringPage(page, now);
    for (const media of chunk.items) appendMedia(media);
    if (!chunk.hasNextPage) break;
    await wait(ANILIST_REQUEST_DELAY_MS);
  }

  // The chronological airing feed can be exhausted by weekly episodes from
  // shows already on air before it reaches the next season. Query both season
  // catalogs explicitly so confirmed premieres and sequels are not omitted.
  const currentSeason = getCurrentSeason();
  const seasons = [currentSeason, getNextSeason(currentSeason)];
  for (const season of seasons) {
    for (let page = 1; page <= ANILIST_SEASON_MAX_PAGES; page++) {
      const chunk = await fetchAnilistSeasonPage(page, season);
      for (const media of chunk.items) appendMedia(media);
      if (!chunk.hasNextPage) break;
      await wait(ANILIST_REQUEST_DELAY_MS);
    }
  }

  return dedupeByEpisode(releases)
    .filter((item) => {
      const releaseAt = Date.parse(item.releaseDate || "");
      return Number.isFinite(releaseAt) && releaseAt > Date.now();
    })
    .sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
}

async function fetchAnilistAiringPage(page, now) {
  const query = `query ($page: Int, $now: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $now, sort: TIME) {
        episode
        airingAt
        media {
        id
        title { romaji english native }
        synonyms
        format
        genres
        isAdult
        coverImage { large medium }
        siteUrl
        averageScore
        meanScore
        nextAiringEpisode { episode airingAt }
        tags { name isAdult rank }
        externalLinks { site url type }
        streamingEpisodes { site url title thumbnail }
        }
      }
    }
  }`;
  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      query,
      variables: { page, now }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AniList ${response.status}: ${body.slice(0, 120)}`);
  }

  const json = await response.json();
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  return {
    hasNextPage: Boolean(json.data?.Page?.pageInfo?.hasNextPage),
    items: (json.data?.Page?.airingSchedules || []).map(mapPublicAnilistAiringSchedule).filter(Boolean)
  };
}

function mapPublicAnilistAiringSchedule(schedule) {
  if (!schedule?.media) return null;
  return mapPublicAnilistMedia({
    ...schedule.media,
    nextAiringEpisode: {
      episode: schedule.episode,
      airingAt: schedule.airingAt
    }
  });
}

function mapPublicAnilistMedia(media) {
  const title = media.title?.english || media.title?.romaji || media.title?.native || "Sin titulo";
  const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);
  const streams = getAnilistStreams(media);
  const best = chooseBestStream(streams);
  return {
    anilistId: media.id,
    title,
    titles,
    coverUrl: media.coverImage?.large || media.coverImage?.medium || "",
    siteUrl: media.siteUrl || "",
    anilistFormat: media.format || "",
    isAdult: Boolean(media.isAdult),
    genres: media.genres || [],
    tags: media.tags || [],
    anilistScore: normalizeAnilistScore(media.averageScore, media.meanScore),
    episode: media.nextAiringEpisode?.episode ? `Ep ${media.nextAiringEpisode.episode}` : "",
    episodeNumber: media.nextAiringEpisode?.episode || null,
    releaseDate: media.nextAiringEpisode?.airingAt ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString() : "",
    service: best?.service || "No legal platform",
    serviceUrl: best?.url || "",
    allServices: streams.map((stream) => stream.service),
    hasAllowedPlatform: Boolean(best)
  };
}

function mapPublicAnilistRelease(media) {
  const releaseDate = new Date(media.releaseDate).toISOString();
  const episodeNumber = media.episodeNumber || parseEpisodeNumber(media.episode) || "?";
  const title = media.title || "Sin titulo";
  return {
    id: stableId("anilist-missing", media.anilistId || title, episodeNumber, releaseDate),
    animeKey: stableId(title),
    anilistId: media.anilistId,
    anilistTitle: title,
    anilistUrl: media.siteUrl || "",
    anilistFormat: media.anilistFormat || "",
    anilistScore: media.anilistScore,
    titles: media.titles || [title],
    title,
    route: "",
    episode: media.episode || `Ep ${episodeNumber}`,
    episodeNumber: String(episodeNumber),
    airType: "SUB",
    delayed: false,
    releaseDate,
    originalReleaseDate: "",
    service: media.service || "No legal platform",
    serviceUrl: media.hasAllowedPlatform ? normalizeUrl(media.serviceUrl || "") : "",
    allServices: media.allServices || [],
    hasAllowedPlatform: Boolean(media.hasAllowedPlatform),
    source: "anilist-missing",
    favorite: false,
    coverUrl: normalizeUrl(media.coverUrl || "")
  };
}

function getAnilistStreams(media) {
  const links = [
    ...(media.externalLinks || []).map((link) => ({ site: link.site, url: link.url })),
    ...(media.streamingEpisodes || []).map((episode) => ({ site: episode.site, url: episode.url }))
  ];
  const seen = new Set();
  return links
    .map((link) => ({ service: platformToService(link.site), url: normalizeUrl(link.url || "") }))
    .filter((stream) => stream.service && stream.url)
    .filter((stream) => {
      const key = `${stream.service}|${stream.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function fetchAnimeScheduleWeek(week, timezone, token) {
  const params = new URLSearchParams({
    year: String(week.year),
    week: String(week.week),
    tz: timezone,
    api_token: token
  });
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

  return fetch(`${API_BASE}/timetables?${params}`, {
    headers: {
      accept: "application/json, */*",
      authorization,
      referer: "https://animeschedule.net/",
      origin: "https://animeschedule.net"
    }
  });
}

async function fetchAnimeScheduleWeekWithRetry(week, timezone, token) {
  const attempts = Number(process.env.ANIMESCHEDULE_RETRIES || "3");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchAnimeScheduleWeek(week, timezone, token);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) {
        return response;
      }
      console.warn(`AnimeSchedule ${response.status} en ${week.year} semana ${week.week}; reintento ${attempt}/${attempts}.`);
    } catch (error) {
      if (attempt === attempts) {
        console.warn(`AnimeSchedule fallo en ${week.year} semana ${week.week}: ${error.message || error}`);
        return null;
      }
      console.warn(`AnimeSchedule fallo en ${week.year} semana ${week.week}; reintento ${attempt}/${attempts}: ${error.message || error}`);
    }
    await wait(1000 * attempt);
  }
  return null;
}

function normalizeSchedule(items, timeZone) {
  const out = [];
  for (const item of items) {
    const airType = String(item.airType || item.air_type || "sub").toLowerCase();
    if (airType !== "sub") continue;

    const releaseDate = getAnimeScheduleSubReleaseDate(item);
    const normalizedReleaseDate = normalizeScheduleDate(releaseDate, timeZone);
    if (!normalizedReleaseDate) continue;

    const title = item.title || item.romaji || item.english || item.native || "Sin titulo";
    const episodeNumber = String(item.episodeNumber ?? item.episode_number ?? item.episode ?? "?");
    const streams = getStreams(item).map(normalizeStream).filter(Boolean);
    const allowed = streams.filter((stream) => stream.service);
    const best = chooseBestStream(allowed);
    const hasAllowedPlatform = Boolean(best);

    out.push({
      id: stableId("schedule", title, episodeNumber, releaseDate),
      animeKey: stableId(title),
      title,
      route: item.route || "",
      episode: `Ep ${episodeNumber}`,
      episodeNumber,
      airType: "SUB",
      delayed: isDelayed(item, timeZone),
      releaseDate: normalizedReleaseDate,
      originalReleaseDate: normalizeScheduleDate(getAnimeScheduleOriginalReleaseDate(item), timeZone) || "",
      service: best?.service || "No legal platform",
      serviceUrl: hasAllowedPlatform ? normalizeUrl(best.url || "") : "",
      allServices: allowed.map((stream) => stream.service),
      hasAllowedPlatform,
      coverUrl: buildCoverUrl(item)
    });
  }

  return dedupeByEpisode(out).sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
}

async function enrichAndAppendAnilistReleases(baseReleases, timeZone = "Europe/Madrid") {
  const anilistReleases = await fetchPublicAnilistSchedule();
  if (!anilistReleases.length) throw new Error("AniList devolvio una agenda vacia");
  const verifiedBaseReleases = reconcileAnimeScheduleWithAnilist(baseReleases, anilistReleases, timeZone);
  let matched = 0;
  const enriched = verifiedBaseReleases.map((item) => {
    const media = findMatchingRelease(item, anilistReleases);
    if (!media) return item;
    matched++;
    const hasNewPlatform = !item.hasAllowedPlatform && media.hasAllowedPlatform;
    return {
      ...item,
      anilistId: media.anilistId || item.anilistId,
      anilistTitle: media.anilistTitle || media.title || item.anilistTitle,
      anilistUrl: media.anilistUrl || item.anilistUrl,
      anilistFormat: media.anilistFormat || item.anilistFormat,
      anilistScore: media.anilistScore ?? item.anilistScore,
      titles: media.titles?.length ? media.titles : (item.titles || []),
      coverUrl: media.coverUrl || item.coverUrl,
      ...(hasNewPlatform ? {
        service: media.service,
        serviceUrl: media.serviceUrl,
        allServices: media.allServices || [media.service],
        hasAllowedPlatform: true
      } : {})
    };
  });
  const missing = anilistReleases
    .filter((item) => !hasScheduledSeriesMatch(item, enriched))
    .map((item) => ({ ...item, source: "anilist-missing", id: stableId("anilist-missing", item.anilistId || item.title, item.episodeNumber, item.releaseDate) }));

  if (missing.length) console.log(`AniList anadio ${missing.length} animes que no estaban en AnimeSchedule.`);
  return {
    releases: dedupeByEpisode(enriched.concat(missing)).sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate)),
    matched,
    added: missing.length
  };
}

async function fetchAnilistSeasonPage(page, { season, year }) {
  const query = `query ($page: Int, $season: MediaSeason, $year: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(
        season: $season,
        seasonYear: $year,
        type: ANIME,
        status_in: [NOT_YET_RELEASED, RELEASING],
        sort: [START_DATE, POPULARITY_DESC]
      ) {
        id
        title { romaji english native }
        synonyms
        format
        genres
        isAdult
        coverImage { large medium }
        siteUrl
        averageScore
        meanScore
        nextAiringEpisode { episode airingAt }
        tags { name isAdult rank }
        externalLinks { site url type }
        streamingEpisodes { site url title thumbnail }
      }
    }
  }`;
  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      query,
      variables: { page, season: String(season || "").toUpperCase(), year }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AniList ${response.status}: ${body.slice(0, 120)}`);
  }

  const json = await response.json();
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  return {
    hasNextPage: Boolean(json.data?.Page?.pageInfo?.hasNextPage),
    items: (json.data?.Page?.media || []).map(mapPublicAnilistMedia).filter(Boolean)
  };
}

function reconcileAnimeScheduleWithAnilist(baseReleases, anilistReleases, timeZone = "Europe/Madrid") {
  const groups = new Map();
  for (const item of baseReleases) {
    const key = stableId(item.animeKey || item.route || item.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const verified = [];
  let removed = 0;
  let corrected = 0;
  for (const group of groups.values()) {
    const media = findMatchingRelease(group[0], anilistReleases);
    if (!media) {
      if (hasRepeatedEpisodeOnDifferentDates(group)) {
        removed += group.length;
        console.warn(`Se descarta "${group[0].title}": AnimeSchedule repite el mismo episodio en varias fechas y AniList no confirma uno siguiente.`);
      } else {
        verified.push(...group);
      }
      continue;
    }

    const confirmedAt = Date.parse(media.releaseDate || "");
    const confirmedEpisode = parseEpisodeNumber(media.episodeNumber ?? media.episode);
    if (!Number.isFinite(confirmedAt) || !Number.isFinite(confirmedEpisode)) {
      verified.push(...group);
      continue;
    }

    const confirmedDay = getCalendarDayKey(confirmedAt, timeZone);
    const consistent = group.filter((item) => {
      const releaseAt = Date.parse(item.releaseDate || "");
      const episode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
      if (!Number.isFinite(releaseAt)) return false;
      const releaseDay = getCalendarDayKey(releaseAt, timeZone);
      if (releaseDay < confirmedDay) return false;
      if (Number.isFinite(episode) && episode < confirmedEpisode) return false;
      // AniList decides the calendar day. AnimeSchedule remains authoritative
      // for the hour, so a different time on the same day is not a conflict.
      if (Number.isFinite(episode) && episode === confirmedEpisode && releaseDay !== confirmedDay) return false;
      return true;
    });
    removed += group.length - consistent.length;

    const hasConfirmedRow = consistent.some((item) => {
      const releaseAt = Date.parse(item.releaseDate || "");
      const episode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
      return episode === confirmedEpisode && getCalendarDayKey(releaseAt, timeZone) === confirmedDay;
    });

    if (!hasConfirmedRow) {
      const sameEpisodeTemplates = group.filter((item) =>
        parseEpisodeNumber(item.episodeNumber ?? item.episode) === confirmedEpisode
      );
      const template = [...(sameEpisodeTemplates.length ? sameEpisodeTemplates : group)]
        .sort((a, b) => scoreItem(b) - scoreItem(a))[0];
      const templateAt = Date.parse(template?.releaseDate || "");
      const correctedReleaseDate = Number.isFinite(templateAt)
        ? replaceCalendarDayKeepTime(templateAt, confirmedAt, timeZone)
        : new Date(confirmedAt).toISOString();
      const hasTemplatePlatform = Boolean(template?.hasAllowedPlatform);
      const service = hasTemplatePlatform ? template.service : media.service;
      const serviceUrl = hasTemplatePlatform ? template.serviceUrl : media.serviceUrl;
      consistent.push({
        ...template,
        id: stableId("schedule-anilist-confirmed", media.anilistId || media.title, confirmedEpisode, correctedReleaseDate),
        episode: `Ep ${confirmedEpisode}`,
        episodeNumber: String(confirmedEpisode),
        releaseDate: correctedReleaseDate,
        originalReleaseDate: "",
        delayed: false,
        service: service || "No legal platform",
        serviceUrl: normalizeUrl(serviceUrl || ""),
        allServices: hasTemplatePlatform ? (template.allServices || [template.service]) : (media.allServices || []),
        hasAllowedPlatform: Boolean(service && service !== "No legal platform"),
        confirmedByAniList: true
      });
      corrected++;
    }
    verified.push(...consistent);
  }

  if (removed || corrected) {
    console.log(`Verificacion AniList: ${removed} horarios contradictorios eliminados, ${corrected} proximos episodios corregidos.`);
  }
  return dedupeByEpisode(verified).sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
}

function hasRepeatedEpisodeOnDifferentDates(group) {
  const datesByEpisode = new Map();
  for (const item of group) {
    const episode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
    const releaseAt = Date.parse(item.releaseDate || "");
    if (!Number.isFinite(episode) || !Number.isFinite(releaseAt)) continue;
    if (!datesByEpisode.has(episode)) datesByEpisode.set(episode, new Set());
    datesByEpisode.get(episode).add(new Date(releaseAt).toISOString());
  }
  return [...datesByEpisode.values()].some((dates) => dates.size > 1);
}

function findMatchingRelease(item, candidates) {
  if (item.anilistId) {
    const byId = candidates.find((candidate) => String(candidate.anilistId) === String(item.anilistId));
    if (byId) return byId;
  }
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = getSeriesMatchScore(item, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 0.78 ? best : null;
}

function getAnimeScheduleSubReleaseDate(item) {
  return firstDateValue(
    item.subReleaseDate,
    item.sub_release_date,
    item.subEpisodeDate,
    item.sub_episode_date,
    item.subAirDate,
    item.sub_air_date,
    item.subAiringDate,
    item.sub_airing_date,
    item.subTimetable,
    item.sub_timetable,
    item.subDelayedTimetable,
    item.sub_delayed_timetable,
    item.subDelayedUntil,
    item.sub_delayed_until,
    item.releaseDate,
    item.release_date,
    item.episodeDate,
    item.episode_date,
    item.airDate,
    item.air_date,
    item.scheduledDate,
    item.scheduled_date
  );
}

function getAnimeScheduleOriginalReleaseDate(item) {
  return firstDateValue(
    item.originalReleaseDate,
    item.original_release_date,
    item.originalEpisodeDate,
    item.original_episode_date,
    item.expectedDate,
    item.expected_date,
    item.scheduledDate,
    item.scheduled_date
  );
}

function firstDateValue(...values) {
  return values.find((value) => {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return false;
    if (/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?/.test(raw)) return true;
    return Number.isFinite(Date.parse(raw));
  }) || "";
}

function normalizeScheduleDate(value, timeZone = "UTC") {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return "";
  const isoish = raw.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoish);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoish)) {
    try { return zonedLocalIsoToUtcIso(isoish, timeZone || "UTC"); } catch (_) {}
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const parsedIsoish = Date.parse(isoish);
  return Number.isFinite(parsedIsoish) ? new Date(parsedIsoish).toISOString() : "";
}

function getStreams(item) {
  if (Array.isArray(item.streams)) return item.streams;
  if (Array.isArray(item.websites?.streams)) return item.websites.streams;
  if (Array.isArray(item.website?.streams)) return item.website.streams;
  return [];
}

function normalizeStream(stream) {
  const platform = String(stream.platform || stream.name || "").toLowerCase();
  const service = platformToService(platform);
  return { platform, service, url: stream.url || "" };
}

function platformToService(platform) {
  const v = String(platform || "").toLowerCase().trim();
  if (!v) return null;
  if (v.includes("crunchyroll")) return "Crunchyroll";
  if (v.includes("funimation")) return "Funimation";
  if (v.includes("hidive")) return "HIDIVE";
  if (v.includes("netflix")) return "Netflix";
  if (v.includes("amazon") || v.includes("prime video") || v.includes("primevideo")) return "Prime Video";
  if (v.includes("disney")) return "Disney+";
  if (v.includes("hulu") && !v.includes("nohulu")) return "Hulu";
  if (v.includes("apple tv") || v.includes("appletv") || v === "apple") return "Apple TV+";
  if (v.includes("hbo") || v.includes("hbomax") || v === "max") return "Max";
  if (v.includes("paramount")) return "Paramount+";
  if (v.includes("peacock")) return "Peacock";
  if (v.includes("vrv")) return "VRV";
  if (v.includes("wakanim")) return "Wakanim";
  if (v.includes("bilibili")) return "Bilibili";
  if (v.includes("aniplus")) return "Aniplus";
  if (v.includes("muse asia") || v.includes("muse_asia")) return "Muse Asia";
  if (v.includes("ani-one") || v.includes("anione")) return "Ani-One";
  if (v.includes("tubi")) return "Tubi";
  return null;
}

function chooseBestStream(streams) {
  return [...streams].sort((a, b) => (SERVICE_PRIORITY[a.service] || 99) - (SERVICE_PRIORITY[b.service] || 99))[0] || null;
}

function isDelayed(item, timeZone) {
  const status = String(item.delayedTimetable || item.subDelayedTimetable || item.status || item.airingStatus || "").trim().toLowerCase();
  const releaseAt = Date.parse(normalizeScheduleDate(getAnimeScheduleSubReleaseDate(item), timeZone));
  const originalAt = parseRealDate(normalizeScheduleDate(getAnimeScheduleOriginalReleaseDate(item), timeZone));
  const changedDay = isLaterCalendarDay(releaseAt, originalAt, timeZone) ||
    isActiveDelayRange(releaseAt, item.delayedFrom, item.delayedUntil, timeZone) ||
    isActiveDelayRange(releaseAt, item.subDelayedFrom, item.subDelayedUntil, timeZone);
  if (changedDay) return true;
  return ["postponed indefinitely", "on break", "hiatus", "cancelled"].includes(status);
}

function isActiveDelayRange(releaseAt, fromValue, untilValue, timeZone) {
  if (!Number.isFinite(releaseAt)) return false;
  const from = parseRealDate(fromValue);
  const until = parseRealDate(untilValue);
  if (!from || !until) return false;
  return isLaterCalendarDay(until, from, timeZone) && isSameCalendarDay(releaseAt, until, timeZone);
}

function parseRealDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

function getCalendarDayKey(time, timeZone) {
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(time));
}

function isSameCalendarDay(a, b, timeZone) {
  const ak = getCalendarDayKey(a, timeZone), bk = getCalendarDayKey(b, timeZone);
  return Boolean(ak && bk && ak === bk);
}

function isLaterCalendarDay(actualTime, plannedTime, timeZone) {
  const actualDay = getCalendarDayKey(actualTime, timeZone);
  const plannedDay = getCalendarDayKey(plannedTime, timeZone);
  return Boolean(actualDay && plannedDay && actualDay > plannedDay);
}

function replaceCalendarDayKeepTime(timeToKeep, daySourceTime, timeZone) {
  const tz = timeZone || "UTC";
  const dayParts = getDateTimePartsInZone(new Date(daySourceTime), tz);
  const timeParts = getDateTimePartsInZone(new Date(timeToKeep), tz);
  const localIso = `${dayParts.year}-${dayParts.month}-${dayParts.day}T${timeParts.hour}:${timeParts.minute}:${timeParts.second}`;
  return zonedLocalIsoToUtcIso(localIso, tz);
}

function getDateTimePartsInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function zonedLocalIsoToUtcIso(localIso, timeZone) {
  let guess = new Date(`${localIso}Z`).getTime();
  for (let i = 0; i < 3; i++) {
    const parts = getDateTimePartsInZone(new Date(guess), timeZone);
    const asUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const target = Date.parse(`${localIso}Z`);
    guess += target - asUtc;
  }
  return new Date(guess).toISOString();
}

function buildCoverUrl(item) {
  const direct = [
    item.image,
    item.imageUrl,
    item.coverUrl,
    item.poster,
    item.posterUrl,
    item.coverImage,
    item.thumbnail,
    item.thumbnailUrl
  ].filter(Boolean).map(normalizeUrl).find(Boolean);

  if (direct) return direct;
  const route = String(item.imageVersionRoute || "").trim();
  return route ? `${IMAGE_BASE}${route}` : "";
}

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.timetables)) return data.timetables;
  if (Array.isArray(data.anime)) return data.anime;
  return [];
}

function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  return { season: month <= 3 ? "winter" : month <= 6 ? "spring" : month <= 9 ? "summer" : "fall", year };
}

function getNextSeason({ season, year }) {
  const next = { winter: "spring", spring: "summer", summer: "fall", fall: "winter" };
  return { season: next[season], year: season === "fall" ? year + 1 : year };
}

function getNextWeeks(amount) {
  const weeks = [];
  const start = new Date();
  for (let i = 0; i < amount; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i * 7);
    const iso = getIsoWeek(date);
    const key = `${iso.year}-${iso.week}`;
    if (!weeks.some((week) => `${week.year}-${week.week}` === key)) weeks.push(iso);
  }
  return weeks;
}

function getIsoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return {
    year: target.getUTCFullYear(),
    week: Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  };
}

function dedupeByEpisode(items) {
  const map = new Map();
  for (const item of items) {
    const key = getEpisodeKey(item);
    const current = map.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) map.set(key, item);
  }
  return [...map.values()];
}

function hasScheduledSeriesMatch(item, scheduledItems) {
  return scheduledItems.some((release) => {
    if (stableId(release.animeKey || release.route || release.title) === stableId(item.animeKey || item.route || item.title)) return true;
    return getSeriesMatchScore(release, item) >= 0.78;
  });
}

function getSeriesMatchScore(a, b) {
  if (a.anilistId && b.anilistId) {
    return String(a.anilistId) === String(b.anilistId) ? 1 : 0;
  }
  const aTitles = [a.title, a.anilistTitle, a.route, a.animeKey, ...(a.titles || [])].filter(Boolean);
  const bTitles = [b.title, b.anilistTitle, b.route, b.animeKey, ...(b.titles || [])].filter(Boolean);
  let best = 0;
  for (const left of aTitles) for (const right of bTitles) best = Math.max(best, titleSimilarityScore(left, right));
  return best;
}

function getEpisodeKey(item) {
  const date = item.releaseDate ? new Date(item.releaseDate).toISOString().slice(0, 10) : "no-date";
  return `${stableId(item.animeKey || item.route || item.title)}|${item.episodeNumber}|${date}`;
}

function scoreItem(item) {
  let score = 0;
  if (item.service === "Crunchyroll") score += 80;
  if (item.service === "Netflix") score += 60;
  if (item.service === "Prime Video") score += 50;
  if (item.coverUrl) score += 10;
  return score;
}

function isSchedulableItem(item) {
  if (item.isAdult || hasAdultAnilistTag(item)) return false;
  return true;
}

function isSeasonalSeriesItem(item) {
  const format = String(item.anilistFormat || item.format || "").toUpperCase();
  const releaseAt = Date.parse(item.releaseDate || "");
  return ["TV", "TV_SHORT", "ONA"].includes(format)
    && Number.isFinite(releaseAt)
    && releaseAt > Date.now();
}

function hasAdultAnilistTag(item) {
  const blockedGenres = ["hentai", "erotica"];
  const blockedTags = ["hentai", "nudity", "sexual", "erotica", "incest"];
  const genres = Array.isArray(item.genres) ? item.genres : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];
  if (genres.some((genre) => blockedGenres.includes(String(genre || "").toLowerCase()))) return true;
  return tags.some((tag) => {
    const name = String(tag?.name || tag || "").toLowerCase();
    const rank = Number(tag?.rank || 0);
    const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
    return tag?.isAdult === true || (rank >= 40 && blockedTags.some((word) => tokens.includes(word)));
  });
}

function normalizeAnilistScore(...scores) {
  const value = scores.map(Number).find((score) => Number.isFinite(score) && score > 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseEpisodeNumber(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function titleSimilarityScore(a, b) {
  const ca = normalizeTitle(a);
  const cb = normalizeTitle(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const min = Math.min(ca.length, cb.length);
  const max = Math.max(ca.length, cb.length);
  const ratio = min / max;
  if ((ca.includes(cb) || cb.includes(ca)) && ratio >= 0.55) return 0.9 * ratio + 0.1;
  return Math.max(tokenOverlapScore(a, b), diceCoefficient(ca, cb) * 0.92);
}

function tokenOverlapScore(a, b) {
  const ta = importantTokens(a);
  const tb = importantTokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let matches = 0;
  for (const token of sa) if (sb.has(token)) matches++;
  return (matches / Math.min(sa.size, sb.size) * 0.7) + (matches / Math.max(sa.size, sb.size) * 0.3);
}

function importantTokens(value) {
  const stop = new Set(["the", "and", "for", "with", "from", "season", "part", "cour", "anime", "series", "animation", "new", "episode"]);
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function diceCoefficient(a, b) {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (!ba.length || !bb.length) return 0;
  const counts = new Map();
  for (const gram of ba) counts.set(gram, (counts.get(gram) || 0) + 1);
  let matches = 0;
  for (const gram of bb) {
    const count = counts.get(gram) || 0;
    if (count > 0) {
      matches++;
      counts.set(gram, count - 1);
    }
  }
  return (2 * matches) / (ba.length + bb.length);
}

function bigrams(value) {
  const text = String(value || "");
  const result = [];
  for (let i = 0; i < text.length - 1; i++) result.push(text.slice(i, i + 2));
  return result;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, "season $1")
    .replace(/\bseason\s*(\d+)\b/g, "$1")
    .replace(/\bs(\d+)\b/g, "$1")
    .replace(/\bpart\s*\d+\b/g, "")
    .replace(/\bcour\s*\d+\b/g, "")
    .replace(/\bthe\b/g, "")
    .replace(/\ba\b/g, "")
    .replace(/\ban\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function stableId(...parts) {
  return parts
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.includes(".")) return `https://${value}`;
  return "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  fetchPublicAnilistSchedule,
  reconcileAnimeScheduleWithAnilist,
  getSeriesMatchScore,
  normalizeTitle,
  isSeasonalSeriesItem,
  replaceCalendarDayKeepTime
};

