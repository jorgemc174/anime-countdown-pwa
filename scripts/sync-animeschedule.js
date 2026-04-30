"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = "https://animeschedule.net/api/v3";
const ANILIST_API = "https://graphql.anilist.co";
const IMAGE_BASE = "https://img.animeschedule.net/production/assets/public/img/";
const OUT_FILE = path.resolve(__dirname, "..", "schedule.json");
const SERVICE_PRIORITY = { Crunchyroll: 1, Netflix: 2, "Prime Video": 3, "No legal platform": 99 };
const ANILIST_REQUEST_DELAY_MS = Number(process.env.ANILIST_REQUEST_DELAY_MS || "250");

async function main() {
  const token = process.env.ANIMESCHEDULE_TOKEN;
  if (!token) throw new Error("Missing ANIMESCHEDULE_TOKEN secret.");

  const timezone = process.env.SYNC_TIMEZONE || "Europe/Madrid";
  const weeks = Number(process.env.SYNC_WEEKS || "8");
  const rawItems = [];

  for (const week of getNextWeeks(weeks)) {
    const response = await fetchAnimeScheduleWeek(week, timezone, token);
    if (response.status === 404) {
      console.warn(`Sin datos para ${week.year} semana ${week.week}`);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`AnimeSchedule ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    rawItems.push(...extractArray(data));
  }

  const normalized = normalizeSchedule(rawItems);
  const releases = process.env.ANILIST_VERIFY === "false"
    ? normalized
    : await applyAnilistCorrections(normalized);
  const payload = {
    updatedAt: new Date().toISOString(),
    timezone,
    source: process.env.ANILIST_VERIFY === "false" ? "AnimeSchedule" : "AnimeSchedule+AniList",
    releases
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`schedule.json actualizado: ${releases.length} episodios (${rawItems.length} items leidos).`);
}

async function applyAnilistCorrections(releases) {
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
    const media = await findAnilistMedia(sample);
    await wait(ANILIST_REQUEST_DELAY_MS);

    for (const release of group) {
      const next = media?.nextAiringEpisode;
      const releaseEpisode = parseEpisodeNumber(release.episodeNumber || release.episode);
      const nextEpisode = Number(next?.episode);
      const strongTitleMatch = media ? getAnilistReleaseMatchScore(release, media) >= 0.9 : false;
      const releaseTime = Date.parse(release.releaseDate);
      const nextTime = Date.parse(next?.airingAt ? new Date(next.airingAt * 1000).toISOString() : "");
      const canCorrectEpisode = Number.isFinite(releaseEpisode) && Number.isFinite(nextEpisode) &&
        releaseEpisode === 1 && nextEpisode > 1 && strongTitleMatch;
      const canCorrectDelayDay = Number.isFinite(releaseEpisode) && releaseEpisode === nextEpisode &&
        Number.isFinite(releaseTime) && Number.isFinite(nextTime) && isLaterCalendarDay(nextTime, releaseTime);
      if (!media || (!canCorrectEpisode && !canCorrectDelayDay && !media.id)) {
        out.push(release);
        continue;
      }

      corrected++;
      out.push({
        ...release,
        ...(canCorrectEpisode ? { episode: `Ep ${nextEpisode}`, episodeNumber: String(nextEpisode) } : {}),
        ...(canCorrectDelayDay ? {
          releaseDate: replaceCalendarDayKeepTime(releaseTime, nextTime),
          delayed: true,
          originalReleaseDate: release.originalReleaseDate || release.releaseDate,
          anilistDayCorrection: true
        } : {}),
        anilistId: media.id,
        anilistTitle: media.title?.romaji || media.title?.english || release.title,
        anilistUrl: media.siteUrl || "",
        coverUrl: media.coverImage?.large || media.coverImage?.medium || release.coverUrl,
        correctedByAniList: (canCorrectEpisode || canCorrectDelayDay) || undefined
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

function normalizeSchedule(items) {
  const out = [];
  for (const item of items) {
    const airType = String(item.airType || item.air_type || "sub").toLowerCase();
    if (airType !== "sub") continue;

    const releaseDate = item.episodeDate || item.episode_date || item.airDate || item.air_date;
    if (!releaseDate || Number.isNaN(Date.parse(releaseDate))) continue;

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
      delayed: isDelayed(item),
      releaseDate: new Date(releaseDate).toISOString(),
      service: best?.service || "No legal platform",
      serviceUrl: hasAllowedPlatform ? normalizeUrl(best.url || "") : "",
      allServices: allowed.map((stream) => stream.service),
      hasAllowedPlatform,
      coverUrl: buildCoverUrl(item)
    });
  }

  return dedupeByEpisode(out).sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));
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
  if (platform.includes("crunchyroll")) return "Crunchyroll";
  if (platform.includes("netflix")) return "Netflix";
  if (platform.includes("amazon") || platform.includes("prime")) return "Prime Video";
  return null;
}

function chooseBestStream(streams) {
  return [...streams].sort((a, b) => (SERVICE_PRIORITY[a.service] || 99) - (SERVICE_PRIORITY[b.service] || 99))[0] || null;
}

function isDelayed(item) {
  const status = String(item.delayedTimetable || item.subDelayedTimetable || item.status || item.airingStatus || "").trim().toLowerCase();
  const releaseAt = Date.parse(item.episodeDate || item.episode_date || item.airDate || item.air_date || "");
  const originalAt = parseRealDate(item.originalReleaseDate || item.original_release_date || item.scheduledDate || item.scheduled_date || item.expectedDate || item.expected_date);
  const changedDay = isLaterCalendarDay(releaseAt, originalAt) ||
    isActiveDelayRange(releaseAt, item.delayedFrom, item.delayedUntil) ||
    isActiveDelayRange(releaseAt, item.subDelayedFrom, item.subDelayedUntil);
  if (changedDay) return true;
  return ["postponed indefinitely", "on break", "hiatus", "cancelled"].includes(status);
}

function isActiveDelayRange(releaseAt, fromValue, untilValue) {
  if (!Number.isFinite(releaseAt)) return false;
  const from = parseRealDate(fromValue);
  const until = parseRealDate(untilValue);
  if (!from || !until) return false;
  return isLaterCalendarDay(until, from) && isSameCalendarDay(releaseAt, until);
}

function parseRealDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

function getCalendarDayKey(time) {
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(time));
}

function isSameCalendarDay(a, b) {
  const ak = getCalendarDayKey(a), bk = getCalendarDayKey(b);
  return Boolean(ak && bk && ak === bk);
}

function isLaterCalendarDay(actualTime, plannedTime) {
  const actualDay = getCalendarDayKey(actualTime);
  const plannedDay = getCalendarDayKey(plannedTime);
  return Boolean(actualDay && plannedDay && actualDay > plannedDay);
}

function replaceCalendarDayKeepTime(timeToKeep, daySourceTime) {
  const timeZone = "Europe/Madrid";
  const dayParts = getDateTimePartsInZone(new Date(daySourceTime), timeZone);
  const timeParts = getDateTimePartsInZone(new Date(timeToKeep), timeZone);
  const localIso = `${dayParts.year}-${dayParts.month}-${dayParts.day}T${timeParts.hour}:${timeParts.minute}:${timeParts.second}`;
  return zonedLocalIsoToUtcIso(localIso, timeZone);
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
    .replace(/\bseason\s*\d+\b/g, "")
    .replace(/\bs\d+\b/g, "")
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

