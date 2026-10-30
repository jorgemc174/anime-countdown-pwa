"use strict";
const { isPending, episodeKey } = require("../schedule-policy");
const dns = require("node:dns/promises");
const net = require("node:net");

// Never infer a SUB release from an article's publication date or a Japanese broadcast.
function extractOfficialEvidence(html, episode, url, titles = []) {
  const nodes = [];
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    nodes.push(value);
    Object.values(value).forEach(walk);
  }
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(match[1])); } catch { /* An invalid block is not evidence. */ }
  }
  const structured = nodes.flatMap(node => {
    const types = [].concat(node["@type"] || []);
    const work = node.workPerformed || node.broadcastOfEvent || {};
    if (!types.some(type => ["BroadcastEvent", "ScreeningEvent"].includes(type)) ||
      String(work.episodeNumber ?? node.episodeNumber) !== String(episode) ||
      !(node.subtitleLanguage || work.subtitleLanguage)) return [];
    const series = work.partOfSeries?.name || node.partOfSeries?.name;
    const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (titles.length && (!series || !titles.some(title => normalize(title) === normalize(series)))) return [];
    if (/EventCancelled$/.test(String(node.eventStatus || ""))) return [{ url, kind: "official-sub-cancellation" }];
    const date = String(node.startDate || "");
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) || !Number.isFinite(Date.parse(date))) return [];
    return [{ url, date, kind: "official-sub-announcement" }];
  });
  // Some official news pages do not publish JSON-LD. Accept only explicit,
  // unambiguous SUB reprogramming statements, never arbitrary dates in the page.
  const text = value => value.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const normalize = value => text(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const headings = [...html.matchAll(/<(?:title|h1)\b[^>]*>([\s\S]*?)<\/(?:title|h1)>/gi)].map(match => normalize(match[1]));
  if (!titles.some(title => normalize(title).length >= 5 && headings.some(heading => heading.includes(normalize(title))))) return structured;
  const paragraphs = [...html.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => text(match[2]));
  for (const statement of paragraphs) {
    if (statement.length > 1200 || !/\b(?:sub|subbed|subtitles?|subtitled|subtitulad[oa]s?)\b|字幕/i.test(statement) ||
      !/reschedul|postpon|reprogram|retras|aplaz|延期|変更/i.test(statement)) continue;
    const episodes = [...statement.matchAll(/(?:\b(?:episode|episodio|ep\.?)\s*|第)(\d+)(?:話)?/gi)].map(match => match[1]);
    if (!episodes.length || episodes.some(value => value !== String(episode))) continue;
    const dates = [...statement.matchAll(/\b(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?\b/g)]
      .map(match => `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
    const unique = [...new Set(dates)];
    if (unique.length !== 1 || !Number.isFinite(Date.parse(unique[0])) || new Date(unique[0]).toISOString().slice(0, 10) !== unique[0]) continue;
    structured.push({ url, date: unique[0], kind: "official-sub-announcement", quote: statement });
  }
  return structured;
}

function privateAddress(address) {
  if (net.isIP(address) === 6) return /^(?:$|::(?:1)?$|::ffff:|f[cd]|fe[89ab]|ff)/i.test(address);
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function readOfficialPage(url, fetchImpl = fetch) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || target.port || net.isIP(target.hostname)) throw new Error("Fuente oficial no pública o no HTTPS");
    const addresses = await dns.lookup(target.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Destino oficial no público");
    const response = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(12000), headers: { accept: "text/html" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get("location"), target).href;
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`Fuente oficial HTTP ${response.status}`);
    if (!/text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("Fuente oficial sin HTML");
    let html = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      html += decoder.decode(chunk, { stream: true });
      if (html.length > 1500000) throw new Error("Anuncio oficial demasiado grande");
    }
    html += decoder.decode();
    return { html, url: target.href };
  }
  throw new Error("Demasiadas redirecciones en la fuente oficial");
}

function officialDay(evidence, timezone) {
  if (!evidence.date.includes("T")) return evidence.date;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(evidence.date));
}

function resolveDelay(item, candidate, evidence, now = new Date().toISOString(), timezone = "Europe/Madrid") {
  const base = { ...item, delayed: true, releaseDate: null, scheduleStatus: "pending", confirmedSubDate: "", officialEvidence: [], originalReleaseDate: item.originalReleaseDate || item.releaseDate || "", lastDelayCheck: now };
  if (evidence.some(entry => entry.kind === "official-sub-cancellation")) return { ...base, scheduleStatus: "cancelled", officialEvidence: evidence.map(entry => ({ ...entry, checkedAt: now })) };
  const sources = evidence.filter(entry => entry.kind === "official-sub-announcement");
  if (!sources.length) return base;
  const days = new Set(sources.map(entry => officialDay(entry, timezone)));
  const officialEvidence = sources.map(entry => ({ ...entry, checkedAt: entry.checkedAt || now }));
  if (days.size !== 1) return { ...base, scheduleStatus: "conflict", officialEvidence };
  const [confirmedSubDate] = days;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  if (confirmedSubDate < today) return { ...base, officialEvidence };
  const confirmed = { ...base, scheduleStatus: "date-confirmed", confirmedSubDate, officialEvidence };
  if (!candidate || !Number.isFinite(Date.parse(candidate.releaseDate || "")) || !/^\d{4}-\d{2}-\d{2}T/.test(candidate.releaseDate)) return confirmed;
  const candidateDay = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(candidate.releaseDate));
  if (candidateDay !== confirmedSubDate) return { ...confirmed, scheduleStatus: "conflict" };
  if (Date.parse(candidate.releaseDate) <= Date.parse(now)) return confirmed;
  return { ...candidate, id: item.id, originalReleaseDate: base.originalReleaseDate, delayed: true, scheduleStatus: "rescheduled", confirmedSubDate, officialEvidence, lastDelayCheck: now };
}

async function trackDelays(previous, current, { discoverSources = async () => [], readPage = readOfficialPage, now = new Date().toISOString(), timezone = "Europe/Madrid" } = {}) {
  const candidates = new Map(current.map(row => [episodeKey(row), row]));
  const tracked = new Map();
  for (const row of [...previous, ...current]) {
    if (row.delayed || isPending(row) || row.scheduleStatus === "rescheduled") {
      const key = episodeKey(row);
      const old = tracked.get(key);
      tracked.set(key, { ...old, ...row, id: old?.id || row.id,
        scheduleStatus: old?.scheduleStatus === "cancelled" ? "cancelled" :
          old?.scheduleStatus === "rescheduled" && old.releaseDate === row.releaseDate ? "rescheduled" : row.scheduleStatus,
        originalReleaseDate: old?.originalReleaseDate || old?.releaseDate || row.originalReleaseDate || row.releaseDate });
    }
  }
  const results = [];
  const started = Date.now();
  let checks = 0;
  const pageCache = new Map();
  const sourceCache = new Map();
  const ordered = [...tracked].sort((a, b) => String(a[1].lastDelayCheck || "").localeCompare(String(b[1].lastDelayCheck || "")));
  for (const [key, row] of ordered) {
    if (row.scheduleStatus === "cancelled") { results.push(row); continue; }
    const candidate = candidates.get(key);
    if (row.scheduleStatus === "rescheduled" && candidate?.releaseDate === row.releaseDate) {
      results.push(row);
      continue;
    }
    if (row.scheduleStatus === "rescheduled" && Date.parse(row.releaseDate) <= Date.parse(now)) {
      if (candidate) results.push(candidate);
      continue;
    }
    if (checks >= 12 || Date.now() - started > 100000) {
      results.push({ ...row, releaseDate: null, scheduleStatus: isPending(row) ? row.scheduleStatus : "pending", delayResearchStatus: "queued" });
      continue;
    }
    checks++;
    let urls = row.officialSources || [];
    let lookupError = "";
    try {
      const seriesKey = row.animeKey || row.title;
      if (!sourceCache.has(seriesKey)) sourceCache.set(seriesKey, discoverSources(row));
      urls = [...new Set([...urls, ...await sourceCache.get(seriesKey)])].slice(0, 3);
    }
    catch { lookupError = "No se pudo consultar el directorio de fuentes oficiales"; }
    const evidence = [];
    for (const url of urls) {
      try {
        if (!pageCache.has(url)) pageCache.set(url, readPage(url));
        const page = await pageCache.get(url);
        evidence.push(...extractOfficialEvidence(page.html, row.episodeNumber, page.url, [row.title, row.anilistTitle, ...(row.titles || [])].filter(Boolean)));
        const links = [...page.html.matchAll(/href=["']([^"']+)["']/gi)].map(match => {
          try { return new URL(match[1], page.url); } catch { return null; }
        }).filter(link => link && link.origin === new URL(page.url).origin && /\/(news|notice|information|episode|story)(?:[\/._-]|$)/i.test(link.pathname)).slice(0, 2);
        for (const link of links) {
          if (!pageCache.has(link.href)) pageCache.set(link.href, readPage(link.href));
          const announcement = await pageCache.get(link.href);
          evidence.push(...extractOfficialEvidence(announcement.html, row.episodeNumber, announcement.url, [row.title, row.anilistTitle, ...(row.titles || [])].filter(Boolean)));
        }
      } catch { lookupError = "No se pudo consultar una fuente oficial; se reintentará"; }
    }
    // Previously verified evidence is retained on transport failures, never the old countdown.
    const known = evidence.length ? evidence : lookupError ? (row.officialEvidence || []) : [];
    const resolved = resolveDelay(row, candidate, known, now, timezone);
    results.push({ ...resolved, officialSources: urls, delayCheckError: lookupError,
      delayResearchStatus: lookupError ? "error" : evidence.length ? "confirmed" : "unconfirmed" });
  }
  return current.filter(row => !tracked.has(episodeKey(row))).concat(results);
}

module.exports = { extractOfficialEvidence, resolveDelay, trackDelays, readOfficialPage, privateAddress };
