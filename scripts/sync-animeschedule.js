"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = "https://animeschedule.net/api/v3";
const IMAGE_BASE = "https://img.animeschedule.net/production/assets/public/img/";
const OUT_FILE = path.resolve(__dirname, "..", "schedule.json");
const SERVICE_PRIORITY = { Crunchyroll: 1, Netflix: 2, "Prime Video": 3, "No legal platform": 99 };

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

  const releases = normalizeSchedule(rawItems);
  const payload = {
    updatedAt: new Date().toISOString(),
    timezone,
    source: "AnimeSchedule",
    releases
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`schedule.json actualizado: ${releases.length} episodios (${rawItems.length} items leidos).`);
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
  if (["delayed", "postponed", "on break", "hiatus"].includes(status)) return true;

  const releaseAt = Date.parse(item.episodeDate || item.episode_date || item.airDate || item.air_date || "");
  return isActiveDelayRange(releaseAt, item.delayedFrom, item.delayedUntil) ||
    isActiveDelayRange(releaseAt, item.subDelayedFrom, item.subDelayedUntil);
}

function isActiveDelayRange(releaseAt, fromValue, untilValue) {
  if (!Number.isFinite(releaseAt)) return false;
  const from = parseRealDate(fromValue);
  const until = parseRealDate(untilValue);
  if (!from && !until) return false;
  return (!from || releaseAt >= from) && (!until || releaseAt <= until);
}

function parseRealDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
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

function stableId(...parts) {
  return parts
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/g, "-")
    .replace(/(^-|-$)/g, "");
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
