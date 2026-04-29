"use strict";

// Browser/PWA compatibility layer.
// The original extension uses chrome.storage.local and chrome.tabs.
// In the PWA these are mapped to localStorage and window.open.
const browserApi = {
  storage: {
    local: {
      async get(keys) {
        const raw = localStorage.getItem("animeCountdownStorage");
        const store = parseStoredState(raw);

        if (Array.isArray(keys)) {
          const result = {};
          for (const key of keys) result[key] = store[key];
          return result;
        }

        if (typeof keys === "string") {
          return { [keys]: store[keys] };
        }

        if (keys && typeof keys === "object") {
          const result = {};
          for (const [key, fallback] of Object.entries(keys)) {
            result[key] = store[key] ?? fallback;
          }
          return result;
        }

        return store;
      },

      async set(values) {
        const raw = localStorage.getItem("animeCountdownStorage");
        const store = parseStoredState(raw);
        Object.assign(store, values);
        localStorage.setItem("animeCountdownStorage", JSON.stringify(store));
      }
    }
  },

  tabs: {
    create({ url }) {
      window.open(url, "_blank", "noopener");
    }
  }
};

function parseStoredState(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (error) {
    console.warn("Datos locales corruptos; se reinicia el almacenamiento de la app.", error);
    localStorage.removeItem("animeCountdownStorage");
    return {};
  }
}




const API_BASE = "https://animeschedule.net/api/v3";
const IMAGE_BASE = "https://img.animeschedule.net/production/assets/public/img/";
const SERVICE_PRIORITY = { "Crunchyroll": 1, "Netflix": 2, "Prime Video": 3, "No legal platform": 99, "AniList": 100 };

const $ = (id) => document.getElementById(id);
const state = { releases: [], anilistLibrary: [], anilistMap: {}, customLinks: {}, customPlatforms: {}, viewMode: "today", currentNext: null };
const els = {};

init();

async function init() {
  try {
    cleanupLegacyCaches();
    if (redirectToLocalServer()) return;
    bindElements();
    populateTimezoneOptions();
    await loadState();
    bindEvents();
    render();
    setInterval(render, 1000);
  } catch (error) {
    showFatal(error);
  }
}

function redirectToLocalServer() {
  return false;
}

function cleanupLegacyCaches() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
  }

  if ("caches" in window) {
    caches.keys()
      .then((keys) => keys.filter((key) => key.startsWith("anime-countdown-pwa-")).forEach((key) => caches.delete(key)))
      .catch(() => {});
  }
}

function bindElements() {
  ["settingsBtn","closeSettingsBtn","settingsPanel","statusBox","nextRelease","animeList","importPreview","importBtn","openAnimeScheduleBtn","showAllBtn","showTodayBtn","showFavsBtn","tokenInput","saveTokenBtn","proxyInput","saveProxyBtn","timezoneInput","saveTimezoneBtn","weeksInput","saveWeeksBtn","anilistInput","saveAnilistBtn","syncAnilistBtn","resetBtn"].forEach((id) => els[id] = $(id));
  const missing = ["settingsBtn","settingsPanel","nextRelease","animeList"].filter((id) => !els[id]);
  if (missing.length) throw new Error("Faltan elementos HTML: " + missing.join(", "));
}

function getUTCOffset(zone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const parts = formatter.formatToParts(new Date());
    const date = new Date();
    const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(date.toLocaleString("en-US", { timeZone: zone }));
    const offset = (utcDate - tzDate) / (1000 * 60 * 60);
    const sign = offset <= 0 ? "+" : "-";
    const absOffset = Math.abs(offset);
    const hours = Math.floor(absOffset);
    const minutes = Math.round((absOffset - hours) * 60);
    return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch (e) {
    return "+00:00";
  }
}

function populateTimezoneOptions() {
  const zones = [
    { name: "UTC", offset: "+00:00" },
    { zone: "Europe/London" },
    { zone: "Europe/Madrid" },
    { zone: "Europe/Paris" },
    { zone: "Europe/Berlin" },
    { zone: "Europe/Rome" },
    { zone: "Europe/Istanbul" },
    { zone: "Asia/Dubai" },
    { zone: "Asia/Kolkata" },
    { zone: "Asia/Bangkok" },
    { zone: "Asia/Shanghai" },
    { zone: "Asia/Tokyo" },
    { zone: "Asia/Seoul" },
    { zone: "Australia/Sydney" },
    { zone: "Pacific/Auckland" },
    { zone: "America/Los_Angeles" },
    { zone: "America/Denver" },
    { zone: "America/Chicago" },
    { zone: "America/New_York" },
    { zone: "America/Argentina/Buenos_Aires" },
    { zone: "America/Sao_Paulo" },
  ];
  
  const preferred = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Madrid";
  
  const options = zones.map((item) => {
    const zone = item.zone || item.name;
    const offset = item.offset || getUTCOffset(zone);
    const zoneName = zone.includes("/") ? zone.split("/")[1].replaceAll("_", " ") : zone;
    const display = `${zoneName} (UTC ${offset})`;
    return { zone, display };
  });
  
  // Sort preferred first
  const preferredIndex = options.findIndex((o) => o.zone === preferred);
  if (preferredIndex > 0) {
    const [preferred] = options.splice(preferredIndex, 1);
    options.unshift(preferred);
  }
  
  els.timezoneInput.innerHTML = options
    .map((o) => `<option value="${escapeHtml(o.zone)}">${escapeHtml(o.display)}</option>`)
    .join("");
}

async function loadState() {
  const data = await browserApi.storage.local.get(["releases","anilistLibrary","anilistMap","customLinks","customPlatforms","viewMode","animeScheduleToken","proxyUrl","timezone","weeksToImport","anilistUsername"]);
  state.releases = data.releases || [];
  state.anilistLibrary = data.anilistLibrary || [];
  state.anilistMap = data.anilistMap || {};
  state.customLinks = data.customLinks || {};
  state.customPlatforms = data.customPlatforms || {};
  state.viewMode = data.viewMode || "today";
  els.tokenInput.value = data.animeScheduleToken || "";
  els.proxyInput.value = data.proxyUrl || "";
  els.timezoneInput.value = data.timezone || "Europe/Madrid";
  els.weeksInput.value = data.weeksToImport || 12;
  els.anilistInput.value = data.anilistUsername || "";
}

function bindEvents() {
  els.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(els.settingsPanel.classList.contains("hidden"));
  });
  els.closeSettingsBtn.addEventListener("click", () => setSettingsOpen(false));
  els.showAllBtn.addEventListener("click", () => setMode("all"));
  els.showTodayBtn.addEventListener("click", () => setMode("today"));
  els.showFavsBtn.addEventListener("click", () => setMode("favorites"));
  els.saveTokenBtn.addEventListener("click", saveToken);
  els.saveProxyBtn.addEventListener("click", saveProxy);
  els.saveTimezoneBtn.addEventListener("click", saveTimezone);
  els.saveWeeksBtn.addEventListener("click", saveWeeks);
  els.saveAnilistBtn.addEventListener("click", saveAnilistUsername);
  els.syncAnilistBtn.addEventListener("click", syncAnilist);
  els.importBtn.addEventListener("click", importSchedule);
  els.openAnimeScheduleBtn.addEventListener("click", () => browserApi.tabs.create({ url: "https://animeschedule.net/" }));
  els.resetBtn.addEventListener("click", resetAll);
  els.nextRelease.addEventListener("click", async () => { if (state.currentNext) await openOrAsk(state.currentNext); });
  els.animeList.addEventListener("click", handleListClick);
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  document.body.classList.toggle("settings-open", open);
  els.settingsBtn.setAttribute("aria-expanded", String(open));
}

async function setMode(mode) { state.viewMode = mode; await browserApi.storage.local.set({ viewMode: mode }); render(); }
async function saveToken() { const token = els.tokenInput.value.trim(); if (!token) return showStatus("Pega primero el token.", "error"); await browserApi.storage.local.set({ animeScheduleToken: token }); showStatus("Token guardado.", "success"); }
async function saveProxy() { const url = els.proxyInput.value.trim(); await browserApi.storage.local.set({ proxyUrl: url }); showStatus(url ? "Proxy guardado." : "Proxy eliminado (se usarán proxies públicos).", "success"); }
async function saveTimezone() { const timezone = els.timezoneInput.value.trim() || "Europe/Madrid"; await browserApi.storage.local.set({ timezone }); showStatus("Zona horaria guardada.", "success"); }
async function saveWeeks() { const weeks = Number(els.weeksInput.value || 12); if (!Number.isFinite(weeks) || weeks < 1 || weeks > 26) return showStatus("Semanas debe estar entre 1 y 26.", "error"); await browserApi.storage.local.set({ weeksToImport: Math.floor(weeks) }); showStatus(`Se importarán ${Math.floor(weeks)} semanas.`, "success"); }
async function saveAnilistUsername() { const username = els.anilistInput.value.trim(); if (!username) return showStatus("Pon tu usuario de AniList.", "error"); await browserApi.storage.local.set({ anilistUsername: username }); showStatus("Usuario AniList guardado.", "success"); }

async function syncAnilist() {
  try {
    const username = els.anilistInput.value.trim();
    if (!username) return showStatus("Pon tu usuario de AniList.", "error");
    showStatus("Sincronizando AniList...", "success");
    const library = await fetchAnilistLibrary(username);
    state.anilistLibrary = library.map((item) => applyCustom(item));
    state.anilistMap = buildAnilistMap(library);
    await browserApi.storage.local.set({ anilistUsername: username, anilistLibrary: state.anilistLibrary, anilistMap: state.anilistMap });
    applyAnilistToReleases();
    applyCustomToReleases();
    await saveReleases();
    render();
    showStatus(`AniList sincronizado: ${library.length} animes en emisión.`, "success");
  } catch (error) { showStatus(error.message, "error"); }
}

async function importSchedule() {
  try {
    const token = els.tokenInput.value.trim();
    const timezone = els.timezoneInput.value.trim() || "Europe/Madrid";
    const weeks = Number(els.weeksInput.value || 12);
    if (!token) return showStatus("Falta token de AnimeSchedule.", "error");
    els.importPreview.innerHTML = `<div class="empty-message">Importando ${weeks} semanas...</div>`;
    const rawItems = [];
    for (const weekInfo of getNextWeeks(Math.max(1, Math.min(26, weeks)))) {
      const response = await fetchTimetable(weekInfo, timezone, token);

      // Algunas semanas futuras pueden no existir todavía en AnimeSchedule.
      // Si pasa, saltamos esa semana en vez de romper toda la importación.
      if (response.status === 404) {
        console.warn(`Semana sin timetable: ${weekInfo.week}/${weekInfo.year}`);
        continue;
      }

      if (!response.ok) throw new Error(`AnimeSchedule API respondió ${response.status}`);

      const data = await response.json();
      rawItems.push(...extractArray(data));
    }
    const normalized = normalizeSchedule(rawItems);
    const imported = normalized.map(enrichScheduleItem).filter(Boolean);
    state.releases = mergeDuplicateItems(mergeById(state.releases, imported));
    applyAnilistToReleases();
    applyCustomToReleases();
    await browserApi.storage.local.set({ releases: state.releases, animeScheduleToken: token, timezone, weeksToImport: weeks });
    renderPreview(imported);
    render();
    if (rawItems.length === 0) {
      showStatus("La API devolvió datos vacíos. Comprueba tu token de AnimeSchedule.", "error");
    } else if (imported.length === 0) {
      showStatus(`Se recibieron ${normalized.length} episodios pero ninguno tiene plataforma reconocida (Crunchyroll/Netflix/Prime). Sincroniza AniList o asocia links manualmente.`, "error");
    } else {
      showStatus(`Importados ${imported.length} episodios.`, "success");
    }
  } catch (error) { els.importPreview.innerHTML = ""; showStatus(getFriendlyFetchError(error), "error"); }
}

async function fetchTimetable(weekInfo, timezone, token) {
  const params = new URLSearchParams({ year: weekInfo.year, week: weekInfo.week, tz: timezone });
  const urlWithToken = `${API_BASE}/timetables?${params}&api_token=${encodeURIComponent(token)}`;
  const errors = [];

  // Reads response, validates it's JSON, returns buffered Response or null.
  async function tryFetch(name, fetchFn) {
    try {
      const res = await fetchFn();
      if (res.status === 404) return res;
      if (!res.ok) { errors.push(`${name}:${res.status}`); return null; }
      const text = await res.text();
      const t = text.trimStart();
      if (!t.startsWith("{") && !t.startsWith("[")) { errors.push(`${name}:no-json`); return null; }
      return new Response(text, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (e) { errors.push(`${name}:${(e.message || "error").slice(0, 40)}`); return null; }
  }

  // 1. Custom Cloudflare Worker proxy (set in settings)
  const customProxy = els.proxyInput?.value?.trim();
  if (customProxy) {
    const proxyUrl = `${customProxy.replace(/\/$/, "")}?${params}&api_token=${encodeURIComponent(token)}`;
    const res = await tryFetch("worker", () => fetch(proxyUrl));
    if (res) return res;
  }

  // 2. Direct (simple CORS, no preflight — works if API allows it)
  const result =
    await tryFetch("direct", () => fetch(urlWithToken)) ||
    await tryFetch("corsproxy", () => fetch(`https://corsproxy.io/?url=${encodeURIComponent(urlWithToken)}`)) ||
    await tryFetch("codetabs", () => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(urlWithToken)}`)) ||
    await tryFetch("allorigins", () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(urlWithToken)}`));

  if (!result) throw new Error(`Sin conexión con AnimeSchedule (${errors.join(" | ")}). Despliega el worker.js en Cloudflare y configura la URL en Ajustes.`);
  return result;
}

function getFriendlyFetchError(error) {
  if (error instanceof TypeError && /fetch/i.test(error.message || "")) {
    return "No se pudo conectar con AnimeSchedule. Comprueba tu conexión a Internet e inténtalo de nuevo.";
  }
  return error.message || "No se pudo actualizar horarios.";
}

function extractArray(data) { if (Array.isArray(data)) return data; if (Array.isArray(data.data)) return data.data; if (Array.isArray(data.timetables)) return data.timetables; return []; }

function normalizeSchedule(items) {
  const out = [];
  for (const item of items) {
    const airType = String(item.airType || item.air_type || "sub").toLowerCase();
    if (airType !== "sub") continue;
    const releaseDate = item.episodeDate || item.episode_date || item.airDate || item.air_date;
    if (!releaseDate) continue;
    const title = item.title || item.romaji || item.english || item.native || "Sin título";
    const episodeNumber = item.episodeNumber ?? item.episode_number ?? item.episode ?? "?";
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
      source: "animeschedule-api",
      favorite: false,
      coverUrl: buildCoverUrl(item),
      customUrl: "",
      customPlatformName: ""
    });
  }
  return dedupeByEpisode(out);
}

function getStreams(item) { if (Array.isArray(item.streams)) return item.streams; if (Array.isArray(item.websites?.streams)) return item.websites.streams; if (Array.isArray(item.website?.streams)) return item.website.streams; return []; }
function normalizeStream(stream) { const platform = String(stream.platform || stream.name || "").toLowerCase(); const service = platformToService(platform); return { platform, service, url: stream.url || "" }; }
function platformToService(platform) { if (platform.includes("crunchyroll")) return "Crunchyroll"; if (platform.includes("netflix")) return "Netflix"; if (platform.includes("amazon") || platform.includes("prime")) return "Prime Video"; return null; }
function chooseBestStream(streams) { return [...streams].sort((a,b) => (SERVICE_PRIORITY[a.service] || 99) - (SERVICE_PRIORITY[b.service] || 99))[0] || null; }
function isDelayed(item) { const status = String(item.status || item.airingStatus || "").trim().toLowerCase(); return Boolean(item.delayed === true || item.isDelayed === true || item.delayedFrom || item.delayedUntil || status === "delayed" || status === "postponed"); }
function buildCoverUrl(item) { const direct = [item.image, item.imageUrl, item.coverUrl, item.poster, item.posterUrl, item.coverImage, item.thumbnail, item.thumbnailUrl].filter(Boolean).map(normalizeUrl).find(Boolean); if (direct) return direct; const route = String(item.imageVersionRoute || "").trim(); return route ? `${IMAGE_BASE}${route}` : ""; }

function enrichScheduleItem(item) {
  const key = getAnimeKey(item);
  const match = findAnilistMatch(item);
  const hasAllowedPlatform = item.hasAllowedPlatform !== false;
  if (!hasAllowedPlatform && !match) return null;
  return {
    ...item,
    favorite: Boolean(item.favorite || match || state.anilistLibrary.some((anime) => getAnimeKey(anime) === key)),
    anilistId: match?.anilistId || item.anilistId,
    anilistTitle: match?.title || item.anilistTitle,
    anilistUrl: match?.siteUrl || item.anilistUrl,
    coverUrl: match?.coverUrl || item.coverUrl,
    service: hasAllowedPlatform ? item.service : "No legal platform",
    serviceUrl: hasAllowedPlatform ? item.serviceUrl : "",
    customUrl: state.customLinks[key] || item.customUrl || "",
    customPlatformName: state.customPlatforms[key] || item.customPlatformName || ""
  };
}

async function fetchAnilistLibrary(username) {
  const query = `query ($userName: String) { MediaListCollection(userName: $userName, type: ANIME) { lists { entries { status progress media { id title { romaji english native } synonyms coverImage { large medium } siteUrl episodes status nextAiringEpisode { episode airingAt } } } } } }`;
  const response = await fetch("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ query, variables: { userName: username } }) });
  if (!response.ok) throw new Error(`AniList respondió ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors[0].message || "AniList devolvió error");
  return (json.data?.MediaListCollection?.lists || []).flatMap((list) => list.entries || []).filter((entry) => {
    const media = entry.media;
    return media?.status === "RELEASING" && Boolean(media?.nextAiringEpisode?.airingAt);
  }).map((entry) => {
    const media = entry.media;
    const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);
    const title = media.title?.english || media.title?.romaji || media.title?.native || "Sin título";
    return {
      id: `anilist-${media.id}`,
      animeKey: stableId(title),
      title,
      titles,
      episode: `Ep ${media.nextAiringEpisode.episode}`,
      episodeNumber: media.nextAiringEpisode.episode,
      airType: "SUB",
      delayed: false,
      releaseDate: new Date(media.nextAiringEpisode.airingAt * 1000).toISOString(),
      service: "AniList",
      serviceUrl: "",
      allServices: ["AniList"],
      hasAllowedPlatform: false,
      source: "anilist-library",
      favorite: true,
      coverUrl: media.coverImage?.large || media.coverImage?.medium || "",
      anilistId: media.id,
      anilistUrl: media.siteUrl || "",
      totalEpisodes: media.episodes || null,
      customUrl: "",
      customPlatformName: ""
    };
  });
}

function buildAnilistMap(library) {
  const map = {};
  for (const anime of library) {
    const data = { anilistId: anime.anilistId, title: anime.title, titles: anime.titles || [anime.title], coverUrl: anime.coverUrl, siteUrl: anime.anilistUrl, favorite: true };
    for (const key of buildTitleKeys(data.titles)) map[key] = data;
  }
  return map;
}

function findAnilistMatch(item) {
  const keys = buildTitleKeys([item.title, item.route, item.animeKey, item.anilistTitle].filter(Boolean));
  for (const key of keys) if (state.anilistMap[key]) return state.anilistMap[key];
  let best = null, bestScore = 0;
  for (const key of keys) {
    if (!key || key.length < 6) continue;
    for (const [anilistKey, data] of Object.entries(state.anilistMap)) {
      if (!anilistKey || anilistKey.length < 6) continue;
      const score = titleSimilarityScore(key, anilistKey);
      if (score > bestScore) { bestScore = score; best = data; }
    }
  }
  return bestScore >= 0.62 ? best : null;
}

function titleSimilarityScore(a,b) { const ca = normalizeTitle(a), cb = normalizeTitle(b); if (!ca || !cb) return 0; if (ca === cb) return 1; const min = Math.min(ca.length, cb.length), max = Math.max(ca.length, cb.length); const ratio = min / max; if ((ca.includes(cb) || cb.includes(ca)) && ratio >= 0.55) return 0.9 * ratio + 0.1; return Math.max(tokenOverlapScore(a,b), diceCoefficient(ca,cb) * 0.92); }
function tokenOverlapScore(a,b) { const ta = importantTokens(a), tb = importantTokens(b); if (!ta.length || !tb.length) return 0; const sa = new Set(ta), sb = new Set(tb); let matches = 0; for (const t of sa) if (sb.has(t)) matches++; return (matches / Math.min(sa.size, sb.size) * 0.7) + (matches / Math.max(sa.size, sb.size) * 0.3); }
function importantTokens(v) { const stop = new Set(["the","and","for","with","from","season","part","cour","anime","series","animation","new","episode"]); return String(v||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/g," ").split(/\s+/).filter(t => t.length >= 3 && !stop.has(t)); }
function diceCoefficient(a,b) { const ba = bigrams(a), bb = bigrams(b); if (!ba.length || !bb.length) return 0; const counts = new Map(); for (const g of ba) counts.set(g, (counts.get(g)||0)+1); let m=0; for (const g of bb) { const c = counts.get(g)||0; if (c>0) { m++; counts.set(g,c-1); } } return (2*m)/(ba.length+bb.length); }
function bigrams(v) { const s=String(v||""); const r=[]; for(let i=0;i<s.length-1;i++) r.push(s.slice(i,i+2)); return r; }
function buildTitleKeys(titles) { const keys = new Set(); for (const title of titles) for (const alias of buildTitleAliases(title)) { const n = normalizeTitle(alias), st = stableId(alias); if(n) keys.add(n); if(st) keys.add(st); } return [...keys]; }
function buildTitleAliases(title) { const v=String(title||""); return [...new Set([v, v.replace(/\s*(season|s)\s*\d+$/i,""), v.replace(/\s*part\s*\d+$/i,""), v.replace(/\s*\([^)]*\)\s*$/i,""), v.replace(/\s*(2nd|3rd|4th|5th|second|third|fourth|fifth)\s+season$/i,""), v.replace(/\s*(cour|part)\s*\d+$/i,""), v.replace(/[:\-–—]/g," "), v.replace(/&/g,"and")])].map(x=>x.trim()).filter(Boolean); }

function applyAnilistToReleases() { state.releases = state.releases.map(item => { const match = findAnilistMatch(item); return match ? { ...item, favorite: true, anilistId: match.anilistId, anilistTitle: match.title, anilistUrl: match.siteUrl, coverUrl: match.coverUrl || item.coverUrl, serviceUrl: item.hasAllowedPlatform === false ? "" : item.serviceUrl } : item; }); }
function applyCustomToReleases() { state.releases = state.releases.map(applyCustom); state.anilistLibrary = state.anilistLibrary.map(applyCustom); }
function applyCustom(item) { const key=getAnimeKey(item); return { ...item, customUrl: state.customLinks[key] || item.customUrl || "", customPlatformName: state.customPlatforms[key] || item.customPlatformName || "" }; }

async function handleListClick(event) {
  const actionEl = event.target.closest("[data-action]");
  const card = event.target.closest(".anime-card");
  const action = actionEl?.dataset.action || card?.dataset.action;
  const id = actionEl?.dataset.id || card?.dataset.id;
  if (!action) return;
  event.stopPropagation();
  if (action === "open") { const item = findItemById(id); if (item) await openOrAsk(item); return; }
  if (action === "favorite") { await toggleFavorite(actionEl.dataset.key); return; }
  if (action === "customLink") { await associatePlatform(actionEl.dataset.key); return; }
  if (action === "removeCustomLink") { await removePlatform(actionEl.dataset.key); return; }
  if (action === "delete") { state.releases = state.releases.filter(item => item.id !== id); await saveReleases(); render(); }
}

async function toggleFavorite(key) { const should = !getAllItems().some(item => getAnimeKey(item) === key && item.favorite); state.releases = state.releases.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item); state.anilistLibrary = state.anilistLibrary.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item); await saveAllLists(); render(); }
async function associatePlatform(key) { const sample = findItemByKey(key); const name = prompt("Nombre de la plataforma que quieres mostrar:", state.customPlatforms[key] || sample?.customPlatformName || "Mi plataforma"); if (name === null) return; const cleanName = name.trim(); if(!cleanName) return showStatus("Nombre vacío.", "warn"); const url = prompt(`Pega el enlace para ${cleanName}:`, state.customLinks[key] || sample?.customUrl || ""); if (url === null) return; const cleanUrl = normalizeUrl(url.trim()); if(!cleanUrl) return showStatus("Link inválido.", "warn"); state.customPlatforms[key]=cleanName; state.customLinks[key]=cleanUrl; await browserApi.storage.local.set({ customPlatforms: state.customPlatforms, customLinks: state.customLinks }); applyCustomToReleases(); await saveAllLists(); render(); showStatus(`Plataforma "${cleanName}" asociada.`, "success"); }
async function removePlatform(key) { delete state.customPlatforms[key]; delete state.customLinks[key]; await browserApi.storage.local.set({ customPlatforms: state.customPlatforms, customLinks: state.customLinks }); state.releases = state.releases.map(item => getAnimeKey(item) === key ? { ...item, customUrl:"", customPlatformName:"" } : item); state.anilistLibrary = state.anilistLibrary.map(item => getAnimeKey(item) === key ? { ...item, customUrl:"", customPlatformName:"" } : item); await saveAllLists(); render(); }

async function openOrAsk(item) { const url = getBestWatchUrl(item); if (url) { browserApi.tabs.create({ url }); return; } const ok = confirm(`No hay plataforma asociada para "${item.title}". ¿Quieres asociar un link ahora?`); if (ok) await associatePlatform(getAnimeKey(item)); }
async function resetAll() { if(!confirm("¿Seguro que quieres borrar todos los datos?")) return; state.releases=[]; state.anilistLibrary=[]; state.customLinks={}; state.customPlatforms={}; await browserApi.storage.local.set({ releases: [], anilistLibrary: [], customLinks: {}, customPlatforms: {} }); render(); showStatus("Datos borrados.", "success"); }

function render() { setActiveTab(); renderNextModern(); renderListModern(); }
function setActiveTab() { els.showAllBtn.classList.toggle("active", state.viewMode==="all"); els.showTodayBtn.classList.toggle("active", state.viewMode==="today"); els.showFavsBtn.classList.toggle("active", state.viewMode==="favorites"); }
function getVisibleItems() { if(state.viewMode==="favorites") return getOneNextPerSeries(getFavoriteItems()); if(state.viewMode==="today") return getOneNextPerSeries(getFavoriteItems().filter(item => isToday(item.releaseDate))); return getOneNextPerSeries(state.releases); }
function getFavoriteItems() { const scheduled = state.releases.filter(item => item.favorite); const scheduledKeys = new Set(scheduled.map(getSeriesKey)); const placeholders = state.anilistLibrary.filter(item => item.favorite && !scheduledKeys.has(getSeriesKey(item))).map(applyCustom); return mergeDuplicateItems([...scheduled, ...placeholders]); }
function getOneNextPerSeries(items) { const now = new Date(); const groups = new Map(); for(const item of mergeDuplicateItems(items)) { if(!item.releaseDate) continue; const d = new Date(item.releaseDate); if(Number.isNaN(d.getTime()) || d <= now) continue; const key=getSeriesKey(item); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(item); } const result=[]; for(const eps of groups.values()) { const ordered=sortByDate(eps); if(ordered.length) result.push(ordered[0]); } return sortByDate(result); }

function renderNext() { const items = getVisibleItems(); if(!items.length) { state.currentNext=null; els.nextRelease.className="next-release empty"; els.nextRelease.innerHTML=`<div class="next-content"><div class="next-label">Sin estrenos</div><div class="next-title">No hay próximos episodios</div><div class="next-episode">${state.viewMode==="today" ? "No hay favoritos para hoy." : "Actualiza horarios en Ajustes."}</div></div>`; return; } const item=items[0]; state.currentNext=item; const c=getCountdown(item.releaseDate); els.nextRelease.className="next-release"; els.nextRelease.innerHTML=`${renderCover(item,"next-cover")}<div class="next-content"><div class="next-label">Próximo episodio</div><div class="next-title">${escapeHtml(item.title)}</div><div class="next-episode">${escapeHtml(item.episode)} · ${escapeHtml(item.customPlatformName || item.service)}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div><div class="next-countdown">${escapeHtml(c.text)}</div><div class="next-meta">${escapeHtml(formatDate(item.releaseDate))}</div></div>`; }
function renderList() { const visible=getVisibleItems(); els.animeList.innerHTML=""; if(!visible.length) { els.animeList.innerHTML=`<div class="empty-message">No hay episodios para mostrar.</div>`; return; } const title=state.viewMode==="today"?"Favoritos de hoy":state.viewMode==="favorites"?"Favoritos":"Próximos estrenos"; els.animeList.insertAdjacentHTML("beforeend", `<div class="section-title">${title}</div>`); visible.forEach(item => els.animeList.appendChild(createCard(item))); }
function createCard(item) { const c=getCountdown(item.releaseDate); const service=item.customPlatformName || item.service; const openLabel=item.customUrl ? `Ver en ${item.customPlatformName || "link asociado"}` : getOpenLabel(item.service); const card=document.createElement("article"); card.className="anime-card"; card.dataset.id=item.id; card.dataset.action="open"; card.innerHTML=`${renderCover(item,"cover")}<div class="card-main"><div class="card-top"><div><div class="anime-title">${escapeHtml(item.title)}</div><div class="anime-episode">${escapeHtml(item.episode)} · ${escapeHtml(service)}${isToday(item.releaseDate)?'<span class="today-pill">HOY</span>':""}</div></div><button class="favorite-btn" type="button" aria-label="${item.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}" data-action="favorite" data-key="${escapeHtml(getAnimeKey(item))}">${item.favorite?"★":"☆"}</button></div><div class="countdown">${escapeHtml(c.text)}</div><div class="meta">${escapeHtml(formatDate(item.releaseDate))}</div><div class="badges"><span class="badge badge-blue">SUB</span><span class="badge badge-purple">${escapeHtml(service || "Sin plataforma")}</span>${item.delayed?'<span class="badge badge-orange">Delayed</span>':'<span class="badge badge-green">Normal</span>'}</div><div class="card-actions"><button class="small-btn primary-link" type="button" data-action="open" data-id="${escapeHtml(item.id)}">${escapeHtml(openLabel)}</button><button class="small-btn" type="button" data-action="customLink" data-key="${escapeHtml(getAnimeKey(item))}">Asociar</button>${item.customUrl ? `<button class="small-btn" type="button" data-action="removeCustomLink" data-key="${escapeHtml(getAnimeKey(item))}">Quitar</button>` : ""}${item.source !== "anilist-library" ? `<button class="small-btn" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">Eliminar</button>` : ""}</div></div>`; return card; }
function renderCover(item, cls) { const letter=escapeHtml(String(item.title||"?").trim().charAt(0).toUpperCase() || "?"); if(!item.coverUrl) return `<div class="${cls} placeholder">${letter}</div>`; return `<img class="${cls}" src="${escapeHtml(item.coverUrl)}" alt="${escapeHtml(item.title)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls} placeholder&quot;>${letter}</div>'"/>`; }
function renderPreview(items) { const shown=getOneNextPerSeries(items); els.importPreview.innerHTML=""; shown.slice(0,6).forEach(item => { const card=document.createElement("div"); card.className="result-card"; card.innerHTML=`<div class="result-title">${escapeHtml(item.title)}</div><div class="result-meta">${escapeHtml(item.episode)} · ${escapeHtml(item.service)}<br/>${escapeHtml(formatDate(item.releaseDate))}</div>`; els.importPreview.appendChild(card); }); if(shown.length>6) { const more=document.createElement("div"); more.className="empty-message"; more.textContent=`Y ${shown.length-6} más...`; els.importPreview.appendChild(more); } }

function getCountdown(dateValue) { const target=new Date(dateValue), now=new Date(), diff=target-now; if(Number.isNaN(target.getTime())) return { text:"Fecha inválida", expired:true }; if(diff<=0) return { text:"Ya disponible", expired:true }; const s=Math.floor(diff/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60; return { text:`${d}d ${h}h ${m}min ${sec}s`, expired:false }; }
function formatDate(value) { const d=new Date(value); if(Number.isNaN(d.getTime())) return "Sin fecha"; return new Intl.DateTimeFormat("es-ES",{weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}).format(d); }
function isToday(value) { const d=new Date(value), n=new Date(); return !Number.isNaN(d.getTime()) && d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate(); }

function getNextWeeks(amount) { const weeks=[]; const start=new Date(); for(let i=0;i<amount;i++) { const d=new Date(start); d.setDate(start.getDate()+i*7); const iso=getIsoWeek(d); const key=`${iso.year}-${iso.week}`; if(!weeks.some(w=>`${w.year}-${w.week}`===key)) weeks.push(iso); } return weeks; }
function getIsoWeek(date) { const t=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())); const day=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-day); const yStart=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return { year:t.getUTCFullYear(), week:Math.ceil((((t-yStart)/86400000)+1)/7) }; }

function mergeById(a,b) { const map=new Map(); [...a,...b].forEach(item => map.set(item.id, { ...map.get(item.id), ...item })); return [...map.values()]; }
function dedupeByEpisode(items) { return mergeDuplicateItems(items); }
function mergeDuplicateItems(items) { const map=new Map(); for(const item of items) { const key=getEpisodeKey(item); const current=map.get(key); if(!current || scoreItem(item)>scoreItem(current)) map.set(key, mergeItem(item,current)); else map.set(key, mergeItem(current,item)); } return sortByDate([...map.values()]); }
function mergeItem(win, lose={}) { return { ...win, favorite:Boolean(win.favorite||lose.favorite), coverUrl:win.coverUrl||lose.coverUrl||"", customUrl:win.customUrl||lose.customUrl||"", customPlatformName:win.customPlatformName||lose.customPlatformName||"", anilistId:win.anilistId||lose.anilistId, anilistTitle:win.anilistTitle||lose.anilistTitle, anilistUrl:win.anilistUrl||lose.anilistUrl }; }
function scoreItem(item) { let s=0; if(item.customUrl)s+=100; if(item.service==="Crunchyroll")s+=80; if(item.service==="Netflix")s+=60; if(item.service==="Prime Video")s+=50; if(item.source==="animeschedule-api")s+=40; if(item.coverUrl)s+=10; if(item.favorite)s+=5; if(item.source==="anilist-library")s-=20; return s; }
function sortByDate(items) { return [...items].sort((a,b)=>new Date(a.releaseDate||"9999-12-31")-new Date(b.releaseDate||"9999-12-31")); }
function getEpisodeKey(item) { const ep=item.episodeNumber || String(item.episode||"").replace(/[^0-9]/g,""); const date=item.releaseDate ? new Date(item.releaseDate).toISOString().slice(0,10) : "no-date"; return `${getSeriesKey(item)}|${ep}|${date}`; }
function getAllItems() { return [...state.releases, ...state.anilistLibrary]; }
function findItemById(id) { return getAllItems().find(item=>item.id===id); }
function findItemByKey(key) { return getAllItems().find(item=>getAnimeKey(item)===key); }
function getAnimeKey(item) { return stableId(item.animeKey || item.route || item.title); }
function getSeriesKey(item) { return stableId(item.anilistId || item.anilistTitle || item.animeKey || item.route || normalizeTitle(item.title)); }
function stableId(...parts) { return parts.filter(Boolean).join("-").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/g,"-").replace(/(^-|-$)/g,""); }
function normalizeTitle(value) { return String(value||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/\([^)]*\)/g,"").replace(/\[[^\]]*\]/g,"").replace(/&/g,"and").replace(/\bseason\s*\d+\b/g,"").replace(/\bs\d+\b/g,"").replace(/\bpart\s*\d+\b/g,"").replace(/\bcour\s*\d+\b/g,"").replace(/\bthe\b/g,"").replace(/\ba\b/g,"").replace(/\ban\b/g,"").replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/g,""); }
function normalizeUrl(url) { const v=String(url||"").trim(); if(!v)return ""; if(v.startsWith("http://")||v.startsWith("https://"))return v; if(v.startsWith("//"))return `https:${v}`; if(v.includes("."))return `https://${v}`; return ""; }
function getOpenLabel(service) { if(service==="Crunchyroll")return "Ver en Crunchyroll"; if(service==="Netflix")return "Ver en Netflix"; if(service==="Prime Video")return "Ver en Prime Video"; return "Asociar plataforma"; }
function getBestWatchUrl(item) { const custom=normalizeUrl(item.customUrl); if(custom)return custom; if(["Crunchyroll","Netflix","Prime Video"].includes(item.service)) return normalizeUrl(item.serviceUrl) || defaultServiceUrl(item.service); return ""; }
function defaultServiceUrl(service) { if(service==="Crunchyroll")return "https://www.crunchyroll.com/"; if(service==="Netflix")return "https://www.netflix.com/"; if(service==="Prime Video")return "https://www.primevideo.com/"; return ""; }
function escapeHtml(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }

async function saveReleases() { await browserApi.storage.local.set({ releases: state.releases }); }
async function saveAllLists() { await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary }); }
function showStatus(message,type="") { els.statusBox.textContent=message; els.statusBox.className=`status-box ${type}`; setTimeout(()=>{ els.statusBox.className="status-box hidden"; },6000); }
function showFatal(error) { document.body.innerHTML=`<main style="padding:16px;font-family:Arial;background:#0f172a;color:white;min-height:650px"><h1>Error cargando extensión</h1><pre style="white-space:pre-wrap;color:#fecaca;background:#450a0a;border:1px solid #991b1b;border-radius:12px;padding:10px">${escapeHtml(error?.stack||error?.message||String(error))}</pre></main>`; }
function renderNextModern() {
  const items = getVisibleItems();
  if (!items.length) {
    state.currentNext = null;
    els.nextRelease.className = "next-release empty";
    els.nextRelease.innerHTML = `<div class="next-content"><div class="next-label">Sin estrenos</div><div class="next-title">No hay próximos episodios</div><div class="next-episode">${state.viewMode === "today" ? "No hay favoritos para hoy." : "Actualiza horarios en Ajustes."}</div></div>`;
    return;
  }

  const item = items[0];
  state.currentNext = item;
  const c = getCountdown(item.releaseDate);
  els.nextRelease.className = "next-release";
  els.nextRelease.innerHTML = `${renderCover(item, "next-cover")}<div class="next-content"><div class="next-label">Próximo episodio</div><div class="next-title">${escapeHtml(item.title)}</div><div class="next-episode">${escapeHtml(item.episode)} · ${escapeHtml(item.customPlatformName || item.service)}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div><div class="next-countdown">${escapeHtml(c.text)}</div><div class="next-meta">${escapeHtml(formatDate(item.releaseDate))}</div></div>`;
}

function renderListModern() {
  const visible = getVisibleItems();
  els.animeList.innerHTML = "";
  if (!visible.length) {
    els.animeList.innerHTML = `<div class="empty-message">No hay episodios para mostrar.</div>`;
    return;
  }

  const title = state.viewMode === "today" ? "Favoritos de hoy" : state.viewMode === "favorites" ? "Favoritos" : "Próximos estrenos";
  els.animeList.insertAdjacentHTML("beforeend", `<div class="section-title">${title} · ${visible.length}</div>`);
  visible.forEach((item) => els.animeList.appendChild(createCardModern(item)));
}

function createCardModern(item) {
  const c = getCountdown(item.releaseDate);
  const service = item.customPlatformName || item.service;
  const openLabel = item.customUrl ? `Ver en ${item.customPlatformName || "link asociado"}` : getOpenLabel(item.service);
  const delayedBadge = item.delayed ? '<span class="badge badge-orange">Delayed</span>' : "";
  const customButton = item.customUrl
    ? `<button class="small-btn" type="button" data-action="removeCustomLink" data-key="${escapeHtml(getAnimeKey(item))}">Quitar link</button>`
    : `<button class="small-btn" type="button" data-action="customLink" data-key="${escapeHtml(getAnimeKey(item))}">Asociar link</button>`;
  const card = document.createElement("article");
  card.className = "anime-card";
  card.dataset.id = item.id;
  card.dataset.action = "open";
  card.innerHTML = `${renderCover(item, "cover")}<div class="card-main"><div class="card-top"><div><div class="anime-title">${escapeHtml(item.title)}</div><div class="anime-episode">${escapeHtml(item.episode)} · ${escapeHtml(service)}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div></div><button class="favorite-btn" type="button" aria-label="${item.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}" data-action="favorite" data-key="${escapeHtml(getAnimeKey(item))}">${item.favorite ? "★" : "☆"}</button></div><div class="countdown">${escapeHtml(c.text)}</div><div class="meta">${escapeHtml(formatDate(item.releaseDate))}</div><div class="badges"><span class="badge badge-purple">${escapeHtml(service || "Sin plataforma")}</span>${delayedBadge}</div><div class="card-actions"><button class="small-btn primary-link" type="button" data-action="open" data-id="${escapeHtml(item.id)}">${escapeHtml(openLabel)}</button>${customButton}</div></div>`;
  return card;
}
