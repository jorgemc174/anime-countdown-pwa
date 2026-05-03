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
      openExternalUrl(url);
    }
  }
};

function openExternalUrl(url) {
  if (isMobileLike()) {
    window.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener");
}

function isMobileLike() {
  return Boolean(navigator.userAgentData?.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

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
const APP_CONFIG = window.ANIME_COUNTDOWN_CONFIG || {};
const SHARED_SCHEDULE_URL = String(APP_CONFIG.SHARED_SCHEDULE_URL || "./schedule.json");
const PUBLIC_SCHEDULE_DAYS = Number(APP_CONFIG.PUBLIC_SCHEDULE_DAYS || 45);
const DEFAULT_IMPORT_WEEKS = 4;
const NOTIFICATION_LEAD_MS = 0;
const NOTIFICATION_GRACE_MS = 30 * 60 * 1000;
const VISIBLE_NOTIFICATION_CHECK_MS = 15 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const ANILIST_REFRESH_MS = 12 * 60 * 60 * 1000;
const ANILIST_MANUAL_COOLDOWN_MS = 1 * 60 * 1000;
const PUBLIC_ANILIST_REFRESH_MS = 12 * 60 * 60 * 1000;
const SHARED_SCHEDULE_REFRESH_MS = 30 * 60 * 1000;
const PUBLIC_ANILIST_SEARCH_LIMIT = 35;
const JUSTWATCH_SEARCH_LIMIT = 120;
const SERVICE_PRIORITY = {
  "Crunchyroll": 1, "Funimation": 2, "HIDIVE": 3,
  "Prime Video": 4, "Netflix": 5, "Disney+": 6,
  "Hulu": 7, "Max": 8, "Apple TV+": 9,
  "Paramount+": 10, "Peacock": 11, "VRV": 12,
  "Wakanim": 13, "Bilibili": 14, "Aniplus": 15,
  "Muse Asia": 16, "Ani-One": 17, "Tubi": 18,
  "No legal platform": 99
};
const JUSTWATCH_COUNTRIES = [
  { code: "ES", name: "España", lang: "es" },
  { code: "MX", name: "México", lang: "es" },
  { code: "AR", name: "Argentina", lang: "es" },
  { code: "CL", name: "Chile", lang: "es" },
  { code: "CO", name: "Colombia", lang: "es" },
  { code: "US", name: "EE. UU.", lang: "en" },
  { code: "GB", name: "Reino Unido", lang: "en" },
  { code: "DE", name: "Alemania", lang: "de" },
  { code: "FR", name: "Francia", lang: "fr" },
  { code: "IT", name: "Italia", lang: "it" },
  { code: "BR", name: "Brasil", lang: "pt" },
  { code: "PT", name: "Portugal", lang: "pt" },
];

const $ = (id) => document.getElementById(id);
const state = { releases: [], anilistLibrary: [], anilistMap: {}, customLinks: {}, customPlatforms: {}, viewMode: "today", currentNext: null, timezone: "Europe/Madrid", jwCountry: "ES", hiddenPlatforms: [], notificationEnabled: false, showAnilistScore: true, notifiedReleaseIds: {}, lastSharedSync: "", lastAnilistSync: "", lastAnilistSyncUsername: "", lastPublicAnilistSync: "", searchQuery: "", sortAsc: true };
const els = {};
const autoSaveTimers = {};
let quarterNotificationTimer = null;
let swipeStart = null;

init();

async function init() {
  try {
    cleanupLegacyCaches();
    bindElements();
    populateTimezoneOptions();
    await loadState();
    state.releases = state.releases.filter((r) => r.source !== "test-data");
    bindEvents();
    registerServiceWorker();
    updateNotificationButton();
    render();
    setInterval(updateLiveCountdowns, 1000);
    scheduleMidnightRefresh();
    startNotificationScheduler();
    startAnilistAutoRefresh();
    startPublicAnilistAutoRefresh();
    await refreshSharedSchedule({ silent: true, skipPublicAnilist: true });
    setupCapacitorNotificationTap();
  } catch (error) {
    showFatal(error);
  }
}

function cleanupLegacyCaches() {
  if ("caches" in window) {
    caches.keys()
      .then((keys) => keys.filter((key) => key.startsWith("anime-countdown-pwa-")).forEach((key) => caches.delete(key)))
      .catch(() => {});
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isCapacitor()) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function bindElements() {
  ["settingsBtn","closeSettingsBtn","settingsPanel","statusBox","nextRelease","animeList","showAllBtn","showTodayBtn","showFavsBtn","timezoneInput","countryInput","notificationBtn","testAnimeBtn","anilistInput","syncAnilistBtn","resetBtn","themeBtn","scoreBtn","refreshDataBtn"].forEach((id) => els[id] = $(id));
  const missing = ["settingsBtn","settingsPanel","nextRelease","animeList"].filter((id) => !els[id]);
  if (missing.length) throw new Error("Faltan elementos HTML: " + missing.join(", "));
}

function getUTCOffset(zone) {
  try {
    const now = new Date();
    const getMs = (tz) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      }).formatToParts(now);
      const get = (type) => Number(parts.find((p) => p.type === type)?.value || "0");
      return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    };
    const offsetMs = getMs(zone) - getMs("UTC");
    const sign = offsetMs >= 0 ? "+" : "-";
    const absMinutes = Math.round(Math.abs(offsetMs) / 60000);
    const hours = Math.floor(absMinutes / 60);
    const minutes = absMinutes % 60;
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
  const data = await browserApi.storage.local.get(["releases","anilistLibrary","anilistMap","customLinks","customPlatforms","viewMode","animeScheduleToken","timezone","jwCountry","hiddenPlatforms","anilistUsername","notificationEnabled","showAnilistScore","notifiedReleaseIds","lastSharedSync","lastAnilistSync","lastAnilistSyncUsername","lastPublicAnilistSync","theme"]);
  state.releases = (data.releases || []).map(sanitizePlatformFields);
  state.anilistLibrary = (data.anilistLibrary || []).map(sanitizePlatformFields).map(stripAnilistOnlyTiming);
  state.anilistMap = data.anilistMap || {};
  state.customLinks = data.customLinks || {};
  state.customPlatforms = data.customPlatforms || {};
  sanitizeCustomPlatformStorage();
  applyCustomToReleases();
  state.viewMode = data.viewMode || "today";
  state.timezone = data.timezone || "Europe/Madrid";
  state.jwCountry = data.jwCountry || "ES";
  state.hiddenPlatforms = Array.isArray(data.hiddenPlatforms) ? data.hiddenPlatforms : [];
  populateCountryOptions();
  if (els.countryInput) els.countryInput.value = state.jwCountry;
  state.notificationEnabled = Boolean(data.notificationEnabled);
  state.showAnilistScore = data.showAnilistScore !== false;
  state.notifiedReleaseIds = data.notifiedReleaseIds || {};
  state.lastSharedSync = data.lastSharedSync || "";
  state.lastAnilistSync = data.lastAnilistSync || "";
  state.lastAnilistSyncUsername = data.lastAnilistSyncUsername || "";
  state.lastPublicAnilistSync = data.lastPublicAnilistSync || "";
  state.theme = data.theme || "dark";
  if (els.tokenInput) els.tokenInput.value = data.animeScheduleToken || "";
  els.timezoneInput.value = state.timezone;
  els.anilistInput.value = data.anilistUsername || "";
  applyTheme(state.theme);
  updateScoreButton();
  await saveSanitizedState();
}

function bindEvents() {
  els.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(els.settingsPanel.classList.contains("hidden"));
  });
  els.closeSettingsBtn.addEventListener("click", () => setSettingsOpen(false));
  document.addEventListener("click", (e) => {
    if (!els.settingsPanel.classList.contains("hidden") &&
        !els.settingsPanel.contains(e.target) &&
        !els.settingsBtn.contains(e.target)) {
      setSettingsOpen(false);
    }
  });
  els.showAllBtn.addEventListener("click", () => switchTab("all"));
  els.showTodayBtn.addEventListener("click", () => switchTab("today"));
  els.showFavsBtn.addEventListener("click", () => switchTab("favorites"));
  els.tokenInput?.addEventListener("input", () => debounceAutoSave("token", saveToken));
  els.timezoneInput.addEventListener("change", saveTimezone);
  els.countryInput?.addEventListener("change", saveJwCountry);
  document.getElementById("platformFilterContainer")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.target.closest(".platform-chip");
    if (chip) togglePlatformFilter(chip.dataset.platform);
  });
  els.notificationBtn?.addEventListener("click", toggleNotifications);
  els.testAnimeBtn?.addEventListener("click", addTestAnime30s);
  els.anilistInput.addEventListener("input", () => debounceAutoSave("anilist", saveAnilistUsername));
  els.syncAnilistBtn.addEventListener("click", syncAnilist);
  els.importBtn?.addEventListener("click", importSchedule);
  els.openAnimeScheduleBtn?.addEventListener("click", () => browserApi.tabs.create({ url: "https://animeschedule.net/" }));
  els.resetBtn.addEventListener("click", resetAll);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.refreshDataBtn.addEventListener("click", () => { setSettingsOpen(false); refreshData(); });
  els.scoreBtn?.addEventListener("click", toggleAnilistScore);
  const searchInput = document.getElementById("searchInput");
  const sortBtn = document.getElementById("sortBtn");
  if (searchInput) searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value.trim();
    render();
  });
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      state.sortAsc = !state.sortAsc;
      sortBtn.classList.toggle("asc", state.sortAsc);
      render();
    });
    sortBtn.classList.toggle("asc", state.sortAsc);
  }
  els.nextRelease.addEventListener("click", async () => { if (state.currentNext) await openOrAsk(state.currentNext); });
  els.nextRelease.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  els.nextRelease.addEventListener("auxclick", (e) => { if (e.button !== 1 || !state.currentNext) return; e.preventDefault(); const url = getBestWatchUrl(state.currentNext); if (url) window.open(url, "_blank", "noopener"); });
  els.animeList.addEventListener("click", handleListClick);
  els.animeList.addEventListener("mousedown", (e) => { if (e.button === 1 && e.target.closest(".anime-card")) e.preventDefault(); });
  els.animeList.addEventListener("auxclick", handleListAuxClick);
  bindSwipeNavigation();
  let titleTapTimer = null;
  document.querySelector(".header h1")?.addEventListener("click", () => {
    if (titleTapTimer) { clearTimeout(titleTapTimer); titleTapTimer = null; refreshData(); }
    else { titleTapTimer = setTimeout(() => { titleTapTimer = null; }, 400); }
  });
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  document.body.classList.toggle("settings-open", open);
  els.settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

async function setMode(mode, direction) {
  state.viewMode = mode;
  await browserApi.storage.local.set({ viewMode: mode });
  render();
}

function bindSwipeNavigation() {
  var list = els.animeList;
  if (!list) return;

  var THRESHOLD = 80;
  var swiping = false;
  var swipeStartX = 0;
  var swipePx = 0;

  var modes = ["all", "today", "favorites"];
  var tabs = [els.showAllBtn, els.showTodayBtn, els.showFavsBtn];
  var indicator = document.querySelector(".tab-indicator");

  function edge(dir) {
    var idx = modes.indexOf(state.viewMode);
    return (dir < 0 && idx <= 0) || (dir > 0 && idx >= modes.length - 1);
  }

  function shift(px) {
    var dir = px < 0 ? 1 : -1;
    if (edge(dir)) {
      list.style.transition = "none";
      list.style.transform = "translateX(" + (px * 0.22) + "px)";
      list.style.opacity = "1";
      return;
    }

    list.style.transition = "none";
    list.style.transform = "translateX(" + px + "px)";
    list.style.opacity = 1 - Math.abs(px) / 300;

    var p = Math.min(Math.abs(px) / THRESHOLD, 1);
    var idx = modes.indexOf(state.viewMode);
    var tgt = Math.max(0, Math.min(modes.length - 1, idx + dir));
    if (idx === tgt) return;

    tabs.forEach(function(t) { t.classList.remove("active"); });
    tabs[idx].style.opacity = String(1 - p * 0.5);
    tabs[tgt].style.opacity = String(0.5 + p * 0.5);

    if (indicator) {
      var base = idx;
      var off = (tgt - idx) * p;
      indicator.style.transform = "translateX(calc(" + ((base + off) * 100) + "% + " + ((base + off) * 8) + "px))";
      indicator.style.transition = "none";
    }
  }

  function back() {
    list.style.transition = "transform 280ms var(--ease), opacity 280ms var(--ease)";
    list.style.transform = "translateX(0px)";
    list.style.opacity = "1";
    if (indicator) indicator.style.transition = "transform 280ms var(--ease)";
    finish();
  }

  function finish() {
    swiping = false;
    swipeStartX = 0;
    swipePx = 0;
    swipeStart = null;
    tabs.forEach(function(t) { t.style.opacity = ""; t.style.color = ""; });
    setActiveTab();
  }

  function commit() {
    var dir = swipePx < 0 ? 1 : -1;
    if (edge(dir)) { back(); return; }
    swiping = false;
    swipeStart = null;

    var w = list.offsetWidth || 300;
    var outPx = -dir * (w + 30);

    list.style.transition = "transform 350ms var(--ease)";
    list.style.transform = "translateX(" + outPx + "px)";

    setTimeout(function() {
      list.style.transition = "none";
      list.style.transform = "";
      list.style.opacity = "1";
      goToAdjacentMode(dir);
      finish();
    }, 360);
  }

  list.addEventListener("touchmove", function(e) {
    if (e.touches.length !== 1) return;
    if (!swiping) {
      if (!swipeStart) {
        swipeStartX = e.touches[0].clientX;
        swipeStart = { x: swipeStartX, y: e.touches[0].clientY, time: Date.now() };
        return;
      }
      var dx = e.touches[0].clientX - swipeStartX;
      var dy = e.touches[0].clientY - swipeStart.y;
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5) swiping = true;
    }
    if (!swiping) return;
    var raw = e.touches[0].clientX - swipeStartX;
    if (swipePx !== 0 && (raw > 0) !== (swipePx > 0)) {
      swipeStartX = e.touches[0].clientX - swipePx;
      swipeStart = { x: swipeStartX, y: e.touches[0].clientY, time: Date.now() };
      raw = swipePx;
    }
    swipePx = raw;
    var maxShift = list.offsetWidth || 300;
    shift(Math.max(-maxShift, Math.min(maxShift, swipePx)));
  }, { passive: true });

  list.addEventListener("touchend", function() {
    if (!swiping) { swipeStart = null; return; }
    if (Math.abs(swipePx) >= THRESHOLD) commit();
    else back();
  });

  list.addEventListener("touchcancel", function() { if (swiping) back(); });
}

function switchTab(mode) {
  if (state.viewMode === mode) return;
  setMode(mode);
}

function goToAdjacentMode(direction) {
  const modes = ["all", "today", "favorites"];
  const current = Math.max(0, modes.indexOf(state.viewMode));
  const next = Math.min(modes.length - 1, Math.max(0, current + direction));
  if (next !== current) setMode(modes[next], direction);
}

function debounceAutoSave(key, fn, delay = 450) { clearTimeout(autoSaveTimers[key]); autoSaveTimers[key] = setTimeout(fn, delay); }
async function saveToken() { await browserApi.storage.local.set({ animeScheduleToken: els.tokenInput.value.trim() }); }
async function saveTimezone() { state.timezone = els.timezoneInput.value.trim() || "Europe/Madrid"; await browserApi.storage.local.set({ timezone: state.timezone }); render(); }
async function saveAnilistUsername() { await browserApi.storage.local.set({ anilistUsername: els.anilistInput.value.trim() }); }

function populateCountryOptions() {
  if (!els.countryInput) return;
  els.countryInput.innerHTML = JUSTWATCH_COUNTRIES
    .map((c) => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.name)}</option>`)
    .join("");
}

async function saveJwCountry() {
  const code = els.countryInput?.value || "ES";
  state.jwCountry = code;
  await browserApi.storage.local.set({ jwCountry: code });
  const name = JUSTWATCH_COUNTRIES.find((c) => c.code === code)?.name || code;
  applyCustomToReleases();
  await saveAllLists();
  render();
  showStatus(`País actualizado a ${name}.`, "success");
}

function getDetectedPlatforms() {
  const platforms = new Set();
  for (const item of [...state.releases, ...state.anilistLibrary]) {
    const svc = getDisplayService(item);
    if (svc && svc !== "No legal platform") platforms.add(svc);
    for (const s of (item.allServices || [])) {
      if (s && s !== "No legal platform") platforms.add(s);
    }
  }
  return [...platforms].sort((a, b) => (SERVICE_PRIORITY[a] || 50) - (SERVICE_PRIORITY[b] || 50) || a.localeCompare(b));
}

function renderSettingsPlatformFilter() {
  const container = document.getElementById("platformFilterContainer");
  if (!container) return;
  const platforms = getDetectedPlatforms();
  container.innerHTML = platforms.map((p) => {
    const hidden = state.hiddenPlatforms.includes(p);
    const label = p === "No legal platform" ? "Sin plataforma" : p;
    return `<button class="platform-chip${hidden ? "" : " active"}" data-platform="${escapeHtml(p)}" type="button">${escapeHtml(label)}</button>`;
  }).join("");
}

async function togglePlatformFilter(platform) {
  const idx = state.hiddenPlatforms.indexOf(platform);
  if (idx >= 0) {
    state.hiddenPlatforms.splice(idx, 1);
  } else {
    state.hiddenPlatforms.push(platform);
  }
  renderSettingsPlatformFilter();
  await browserApi.storage.local.set({ hiddenPlatforms: state.hiddenPlatforms });
  render();
}

function filterByPlatform(items) {
  if (!state.hiddenPlatforms.length) return items;
  return items.filter((item) => {
    const service = getDisplayService(item);
    return !state.hiddenPlatforms.includes(service);
  });
}

async function testNotification() {
  if (!isCapacitor()) return showStatus("Solo funciona en la app Android.", "warn");
  if (!state.notificationEnabled) return showStatus("Activa primero las notificaciones.", "warn");

  const testKey = "test-notif-" + Date.now();
  const testId = "test-notif-" + Date.now();
  const releaseAt = Date.now() + 30000;
  const testItem = {
    id: testId,
    animeKey: testKey,
    title: "Anime de Prueba",
    episode: "Ep 1",
    episodeNumber: "1",
    releaseDate: new Date(releaseAt).toISOString(),
    service: "Netflix",
    serviceUrl: "https://netflix.com",
    allServices: ["Netflix"],
    hasAllowedPlatform: true,
    favorite: true,
    source: "test",
    coverUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx197824-k9Uyef8g49hB.png",
    anilistId: 0,
    anilistTitle: "Anime de Prueba"
  };
  state.releases.push(testItem);
  await saveAllLists();

  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) return showStatus("Plugin de notificaciones no disponible.", "error");

  try {
    const permResult = await LocalNotifications.checkPermissions();
    if (permResult.display !== "granted") {
      const reqResult = await LocalNotifications.requestPermissions();
      if (reqResult.display !== "granted") {
        return showStatus("Permiso de notificaciones denegado.", "error");
      }
    }

    const notifId = hashNotificationId(testItem);
    const coverPath = await downloadCoverImage(testItem.coverUrl, notifId);
    await LocalNotifications.schedule({
      notifications: [{
        id: notifId,
        title: "Anime de Prueba Ep 1",
        body: "Ya disponible en Netflix.",
        schedule: { at: new Date(releaseAt) },
        extra: { url: "https://netflix.com" },
        smallIcon: "ic_stat_icon",
        largeIcon: coverPath || undefined,
        iconColor: "#111827",
        actionTypeId: "",
        attachments: coverPath ? [{ id: "cover", url: coverPath }] : null,
        group: "anime-countdown"
      }]
    });

    showStatus("Notificación programada en 30s. Cierra la app para probar.", "success");
  } catch (error) {
    console.error("Error al programar notificación:", error);
    showStatus("Error: " + (error.message || "desconocido"), "error");
  }
  render();
}

async function addTestAnime30s() {
  const templates = state.releases
    .filter((item) => item.coverUrl && item.title && item.source !== "test-data")
    .slice(0, 50);
  if (!templates.length) return showStatus("No hay datos suficientes. Refresca los horarios primero.", "warn");

  const template = templates[Math.floor(Math.random() * templates.length)];
  const seriesKey = getSeriesKey(template);
  const existingEps = state.releases
    .filter((r) => getSeriesKey(r) === seriesKey)
    .map((r) => parseInt(r.episodeNumber))
    .filter((n) => Number.isFinite(n));
  const maxEp = existingEps.length ? Math.max(...existingEps) : 0;
  const nextEp = maxEp + 1;
  const releaseAt = Date.now() + 30 * 1000;
  const releaseDate = new Date(releaseAt).toISOString();

  const testItem = sanitizePlatformFields({
    ...template,
    id: stableId("test", template.title, nextEp, releaseDate),
    episode: "Ep " + nextEp,
    episodeNumber: String(nextEp),
    releaseDate,
    originalReleaseDate: "",
    delayed: false,
    source: "test-data",
    favorite: true,
    customUrl: "",
    customPlatformName: ""
  });

  state.releases.push(testItem);
  state.releases = sortByDate(state.releases);
  await saveAllLists();
  render();

  if (isCapacitor()) {
    const LocalNotifications = getLocalNotifications();
    if (!LocalNotifications) return showStatus("Anime añadido. Plugin de notificaciones no disponible.", "success");

    try {
      const permResult = await LocalNotifications.checkPermissions();
      if (permResult.display !== "granted") {
        const reqResult = await LocalNotifications.requestPermissions();
        if (reqResult.display !== "granted") {
          return showStatus("Anime añadido pero sin permiso de notificaciones.", "warn");
        }
      }

      const notifId = hashNotificationId(testItem);
      const coverPath = await downloadCoverImage(testItem.coverUrl, notifId);
      const bodyText = testItem.service && testItem.service !== "No legal platform"
        ? "Ya disponible en " + testItem.service + "."
        : "Ya disponible.";

      await LocalNotifications.schedule({
        notifications: [{
          id: notifId,
          title: `${testItem.title} ${testItem.episode}`,
          body: bodyText,
          largeBody: bodyText,
          summaryText: bodyText,
          schedule: { at: new Date(releaseAt) },
          extra: { url: getBestWatchUrl(testItem) || location.href, title: testItem.title },
          smallIcon: "ic_stat_icon",
          largeIcon: coverPath || undefined,
          iconColor: "#111827",
          actionTypeId: "",
          attachments: coverPath ? [{ id: "cover", url: coverPath }] : null,
          group: "anime-countdown"
        }]
      });

      showStatus(`${testItem.title} ${testItem.episode} se estrena en 30s. Cierra la app para ver la notificación.`, "success");
    } catch (error) {
      console.error("Error al programar notificación:", error);
      showStatus("Anime añadido pero falló la notificación: " + (error.message || "desconocido"), "error");
    }
  } else {
    showStatus(`${testItem.title} ${testItem.episode} añadido. Se estrena en 30s.`, "success");
    if ("Notification" in window && Notification.permission === "granted" && "serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      const coverUrl = normalizeUrl(testItem.coverUrl);
      const url = getBestWatchUrl(testItem) || location.href;
      registration.showNotification(`${testItem.title} ${testItem.episode}`, {
        body: testItem.service ? `Ya disponible en ${testItem.service}.` : "Ya disponible.",
        icon: coverUrl || "./icons/icon-192.png",
        image: coverUrl || undefined,
        badge: "./icons/notification-badge.svg",
        tag: `anime-${testItem.id}`,
        renotify: true,
        requireInteraction: true,
        timestamp: releaseAt,
        data: { url }
      });
    }
  }

  checkReleaseNotifications();
}

async function toggleNotifications() {
  const hasNativeNotif = isCapacitor();
  const hasWebNotif = "Notification" in window;

  if (!hasNativeNotif && !hasWebNotif) {
    return showStatus("Este dispositivo no soporta notificaciones.", "error");
  }

  if (!state.notificationEnabled) {
    let granted = hasNativeNotif;
    if (hasWebNotif && Notification.permission !== "granted") {
      if (Notification.permission === "denied") {
        state.notificationEnabled = false;
        await browserApi.storage.local.set({ notificationEnabled: false });
        updateNotificationButton();
        return showStatus("Las notificaciones estan bloqueadas en el navegador.", "error");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        state.notificationEnabled = false;
        await browserApi.storage.local.set({ notificationEnabled: false });
        updateNotificationButton();
        return showStatus("No se activaron las notificaciones.", "warn");
      }
    }
    if (hasNativeNotif) {
      try {
        const LocalNotifications = getLocalNotifications();
        if (LocalNotifications) {
          const permResult = await LocalNotifications.requestPermissions();
          granted = permResult.display === "granted";
        }
      } catch (_) {}
    }
    if (!granted) {
      state.notificationEnabled = false;
      await browserApi.storage.local.set({ notificationEnabled: false });
      updateNotificationButton();
      return showStatus("Permiso de notificaciones denegado. Actívalo en Ajustes > Notificaciones.", "error");
    }
    state.notificationEnabled = true;
    await browserApi.storage.local.set({ notificationEnabled: true });
    updateNotificationButton();
    if (hasNativeNotif) {
      cancelStaleNativeNotifications();
      scheduleNativeNotifications();
    }
    showStatus("Notificaciones activadas.", "success");
    checkReleaseNotifications();
    return;
  }

  state.notificationEnabled = false;
  await browserApi.storage.local.set({ notificationEnabled: false });
  if (hasNativeNotif) {
    try {
      const LocalNotifications = getLocalNotifications();
      if (LocalNotifications) await LocalNotifications.cancelAll();
    } catch (_) {}
  }
  updateNotificationButton();
  showStatus("Notificaciones desactivadas.", "success");
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
  if (els.themeBtn) els.themeBtn.setAttribute("aria-checked", theme === "light" ? "true" : "false");
}

async function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  applyTheme(state.theme);
  await browserApi.storage.local.set({ theme: state.theme });
}

async function toggleAnilistScore() {
  state.showAnilistScore = !state.showAnilistScore;
  updateScoreButton();
  await browserApi.storage.local.set({ showAnilistScore: state.showAnilistScore });
  render();
}

function updateScoreButton() {
  if (els.scoreBtn) els.scoreBtn.setAttribute("aria-checked", state.showAnilistScore ? "true" : "false");
}

function updateNotificationButton() {
  if (!els.notificationBtn) return;
  const hasNativeNotif = isCapacitor();
  const hasWebNotif = "Notification" in window;
  if (!hasNativeNotif && !hasWebNotif) {
    els.notificationBtn.disabled = true;
    els.notificationBtn.setAttribute("aria-checked", "false");
    const label = document.getElementById("notificationLabel");
    if (label) label.textContent = "Notificaciones (no disponible)";
    return;
  }
  const active = state.notificationEnabled && (hasNativeNotif || Notification.permission === "granted");
  els.notificationBtn.setAttribute("aria-checked", active ? "true" : "false");
  const label = document.getElementById("notificationLabel");
  if (label) label.textContent = active ? "Notificaciones activadas" : "Activar notificación";
}

async function refreshData() {
  try {
    await refreshSharedSchedule({ silent: true, skipPublicAnilist: true, force: true });
    await saveAllLists();
    if (isCapacitor()) {
      cancelStaleNativeNotifications();
      scheduleNativeNotifications();
    }
    await deferRender();
    const favs = state.releases.filter(i => i.favorite).length;
    const notifMsg = isCapacitor() ? ` | ${favs} con notificaciones` : "";
    showStatus(`Listo.${notifMsg}`, "success");

    verifyPlatformsWithJustWatch().then(async () => {
      await saveAllLists();
      if (isCapacitor()) {
        cancelStaleNativeNotifications();
        scheduleNativeNotifications();
      }
      await deferRender();
    }).catch(() => {});
  } catch (error) {
    showStatus(error.message || "Error al refrescar", "error");
  }
}

function deferRender() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      render();
      resolve();
    });
  });
}

async function syncAnilist() {
  try {
    const username = els.anilistInput.value.trim();
    if (!username) return showStatus("Pon tu usuario de AniList.", "error");
    const last = Date.parse(state.lastAnilistSync || "");
    const isSameUser = state.lastAnilistSyncUsername === username;
    if (isSameUser && Number.isFinite(last) && Date.now() - last < ANILIST_MANUAL_COOLDOWN_MS) {
      const minutes = Math.ceil((ANILIST_MANUAL_COOLDOWN_MS - (Date.now() - last)) / 60000);
      return showStatus(`AniList ya se sincronizó hace poco. Espera ${minutes} min.`, "warn");
    }
    showStatus("Sincronizando base y AniList...", "success");
    await refreshSharedSchedule({ silent: true, skipPublicAnilist: true, force: true });
    const library = await refreshAnilistData(username);
    showStatus("Verificando plataformas con JustWatch...", "success");
    const jwResult = await verifyPlatformsWithJustWatch();
    await saveAllLists();
    await cancelStaleNativeNotifications();
    // Only show scheduled count in Capacitor
    let scheduled = 0;
    if (isCapacitor()) {
      scheduled = await scheduleNativeNotifications();
    }
    render();
    const jwMsg = jwResult.checked > 0 ? ` | JustWatch: ${jwResult.changed} de ${jwResult.checked}` : "";
    const notifMsg = isCapacitor() ? ` | Notificaciones: ${scheduled} programadas` : "";
    showStatus(`AniList sincronizado: ${library.length} animes en emisión.${jwMsg}${notifMsg}`, "success");
  } catch (error) { showStatus(error.message, "error"); }
}

function startAnilistAutoRefresh() {
  maybeRefreshAnilist({ silent: true });
  setInterval(() => maybeRefreshAnilist({ silent: true }), ANILIST_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeRefreshAnilist({ silent: true });
  });
}

function startPublicAnilistAutoRefresh() {
  maybeRefreshPublicAnilist({ silent: true });
  setInterval(() => maybeRefreshPublicAnilist({ silent: true }), PUBLIC_ANILIST_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybeRefreshPublicAnilist({ silent: true });
  });
}

async function maybeRefreshPublicAnilist({ silent = true, force = false } = {}) {
  const last = Date.parse(state.lastPublicAnilistSync || "");
  if (!force && Number.isFinite(last) && Date.now() - last < PUBLIC_ANILIST_REFRESH_MS) return false;
  if (!state.releases.length) return false;
  try {
    await refreshPublicAnilistData();
    render();
    checkReleaseNotifications();
    if (!silent) showStatus("Base general actualizada con AniList.", "success");
    return true;
  } catch (error) {
    console.warn("No se pudo actualizar la base general con AniList.", error);
    if (!silent) showStatus(error.message || "No se pudo actualizar AniList.", "error");
    return false;
  }
}

async function maybeRefreshAnilist({ silent = true } = {}) {
  const data = await browserApi.storage.local.get(["anilistUsername"]);
  const username = String(data.anilistUsername || els.anilistInput?.value || "").trim();
  if (!username) return null;
  const last = Date.parse(state.lastAnilistSync || "");
  if (Number.isFinite(last) && Date.now() - last < ANILIST_REFRESH_MS) return null;
  try {
    const library = await refreshAnilistData(username);
    render();
    checkReleaseNotifications();
    if (!silent) showStatus(`AniList actualizado: ${library.length} animes.`, "success");
    return library;
  } catch (error) {
    console.warn("No se pudo refrescar AniList.", error);
    if (!silent) showStatus(error.message || "No se pudo actualizar AniList.", "error");
    return null;
  }
}

async function refreshAnilistData(username) {
  const library = await fetchAnilistLibrary(username);
  state.anilistLibrary = library.map(stripAnilistOnlyTiming).map((item) => applyCustom(item));
  state.anilistMap = buildAnilistMap(library);
  state.lastAnilistSync = new Date().toISOString();
  state.lastAnilistSyncUsername = username;
  clearStaleAnilistFavorites();
  applyAnilistToReleases();
  reconcileAnilistFavoritesWithSchedule();
  applyCustomToReleases();
  await browserApi.storage.local.set({
    anilistUsername: username,
    anilistLibrary: state.anilistLibrary,
    anilistMap: state.anilistMap,
    releases: state.releases,
    lastAnilistSync: state.lastAnilistSync,
    lastAnilistSyncUsername: state.lastAnilistSyncUsername
  });
  return library;
}

async function refreshPublicAnilistData() {
  try { await enrichReleasesFromPublicAnilist(); } catch (e) { console.warn("AniList público no disponible:", e.message); }
  applyAnilistToReleases();
  applyCustomToReleases();
  state.lastPublicAnilistSync = new Date().toISOString();
  await browserApi.storage.local.set({
    releases: state.releases,
    anilistMap: state.anilistMap,
    lastPublicAnilistSync: state.lastPublicAnilistSync
  });
}

async function importSchedule() {
  try {
    if (isSharedScheduleConfigured()) {
      await refreshSharedSchedule({ silent: false });
      return;
    }

    const token = els.tokenInput?.value?.trim() || "";
    const timezone = els.timezoneInput.value.trim() || "Europe/Madrid";
    if (!token) return showStatus("Falta token de AnimeSchedule.", "error");
    const curr = getCurrentSeason();
    const weeks = getNextWeeks(DEFAULT_IMPORT_WEEKS);
    if (els.importPreview) els.importPreview.innerHTML = `<div class="empty-message">Importando temporada ${curr.season} ${curr.year}…</div>`;
    const rawItems = [];
    for (const week of weeks) {
      const response = await fetchTimetable(week, timezone, token);
      if (response.status === 404) { console.warn(`Sin datos: semana ${week.year}/${week.week}`); continue; }
      if (!response.ok) throw new Error(`AnimeSchedule API respondió ${response.status}`);
      const data = await response.json();
      rawItems.push(...extractArray(data));
    }
    const normalized = normalizeSchedule(rawItems);
    const imported = normalized.map(enrichScheduleItem).map((item) => preserveExistingAnimeData(item));
    state.releases = mergeDuplicateItems(mergeById(state.releases, imported));
    applyAnilistToReleases();
    applyCustomToReleases();
    await browserApi.storage.local.set({ releases: state.releases, animeScheduleToken: token, timezone });
    renderPreview(imported);
    render();
    checkReleaseNotifications();
    if (rawItems.length === 0) {
      showStatus("La API devolvió datos vacíos. Comprueba tu token de AnimeSchedule.", "error");
    } else if (imported.length === 0) {
      showStatus("AnimeSchedule no devolvio episodios SUB con fecha en el rango importado.", "warn");
    } else {
      showStatus(`Importados ${imported.length} episodios de las proximas ${DEFAULT_IMPORT_WEEKS} semanas.`, "success");
    }
  } catch (error) { if (els.importPreview) els.importPreview.innerHTML = ""; showStatus(getFriendlyFetchError(error), "error"); }
}

function isSharedScheduleConfigured() {
  return Boolean(SHARED_SCHEDULE_URL);
}

async function refreshSharedSchedule({ silent = false, skipPublicAnilist = false, force = false } = {}) {
  if (!isSharedScheduleConfigured()) return false;

  if (!force && silent && state.releases.length > 0) {
    const lastSync = Date.parse(state.lastSharedSync || "");
    if (Number.isFinite(lastSync) && Date.now() - lastSync < SHARED_SCHEDULE_REFRESH_MS) return false;
  }

  try {
    if (!silent) {
      if (els.importPreview) els.importPreview.innerHTML = `<div class="empty-message">Cargando horarios compartidos...</div>`;
      showStatus("Actualizando horarios compartidos...", "success");
    }

    const rows = await fetchSharedSchedule();
    const imported = rows.map(mapSharedRelease).map(enrichScheduleItem).map((item) => preserveExistingAnimeData(item));
    const localOnly = state.releases.filter((item) => item.source !== "animeschedule-api" && !String(item.source || "").startsWith("shared-json"));
    state.releases = mergeDuplicateItems(mergeById(localOnly, imported));
    applyAnilistToReleases();
    reconcileAnilistFavoritesWithSchedule();
    if (!skipPublicAnilist) {
      const lastAl = Date.parse(state.lastPublicAnilistSync || "");
      if (!Number.isFinite(lastAl) || Date.now() - lastAl >= PUBLIC_ANILIST_REFRESH_MS) await refreshPublicAnilistData();
    }
    applyCustomToReleases();
    state.lastSharedSync = new Date().toISOString();
    await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary, timezone: state.timezone, lastSharedSync: state.lastSharedSync });
    renderPreview(imported);
    render();
    checkReleaseNotifications();
    cancelStaleNativeNotifications();
    scheduleNativeNotifications();

    if (!silent) {
      showStatus(`Actualizados ${imported.length} episodios desde la base compartida.`, "success");
    }
    return true;
  } catch (error) {
    if (!silent) {
      if (els.importPreview) els.importPreview.innerHTML = "";
      showStatus(getFriendlyFetchError(error), "error");
    } else {
      console.warn("No se pudo cargar la base compartida.", error);
    }
    return false;
  }
}

async function fetchSharedSchedule() {
  const now = new Date();
  const until = new Date(now.getTime() + PUBLIC_SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
  const url = withCacheBuster(SHARED_SCHEDULE_URL);
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`El horario compartido respondio ${response.status}: ${body.slice(0, 120)}`);
  }

  let json;
  try { json = await response.json(); } catch (_) {
    throw new Error("La respuesta del horario compartido no es JSON válido.");
  }
  const rows = Array.isArray(json) ? json : (json.releases || json.data || []);
  return rows.filter((row) => {
    const releaseDate = getSharedSubReleaseDate(row);
    const releaseAt = Date.parse(releaseDate);
    if (!Number.isFinite(releaseAt) || releaseAt > until.getTime()) return false;
    return releaseAt >= now.getTime() || isToday(releaseDate);
  });
}

function mapSharedRelease(row) {
  const releaseDate = getSharedSubReleaseDate(row);
  const title = row.title || "Sin titulo";
  const episodeNumber = row.episode_number ?? row.episodeNumber ?? "?";
  return sanitizePlatformFields({
    id: row.id || stableId("schedule", title, episodeNumber, releaseDate),
    animeKey: row.anime_key || row.animeKey || stableId(title),
    title,
    route: row.route || "",
    episode: row.episode || `Ep ${episodeNumber}`,
    episodeNumber,
    airType: row.air_type || row.airType || "SUB",
    delayed: isDelayed(row),
    releaseDate: new Date(releaseDate).toISOString(),
    originalReleaseDate: row.originalReleaseDate || row.original_release_date || "",
    service: row.service || "No legal platform",
    serviceUrl: normalizeUrl(row.service_url || row.serviceUrl || ""),
    allServices: row.all_services || row.allServices || [],
    hasAllowedPlatform: row.has_allowed_platform ?? row.hasAllowedPlatform ?? Boolean(row.service_url || row.serviceUrl),
    source: "shared-json",
    favorite: false,
    coverUrl: normalizeUrl(row.cover_url || row.coverUrl || ""),
    customUrl: "",
    customPlatformName: ""
  });
}

function preserveExistingAnimeData(item) {
  const existing = findExistingRelease(item);
  if (!existing) return item;
  return {
    ...item,
    favorite: Boolean(item.favorite || existing.favorite),
    delayed: Boolean(item.delayed),
    originalReleaseDate: item.originalReleaseDate || existing.originalReleaseDate || "",
    anilistId: item.anilistId || existing.anilistId,
    anilistTitle: item.anilistTitle || existing.anilistTitle,
    anilistUrl: item.anilistUrl || existing.anilistUrl,
    anilistScore: item.anilistScore ?? existing.anilistScore,
    coverUrl: item.coverUrl || existing.coverUrl,
    customUrl: item.customUrl || existing.customUrl || "",
    customPlatformName: item.customPlatformName || existing.customPlatformName || ""
  };
}

function findExistingRelease(item) {
  const idMatch = state.releases.find((release) => release.id === item.id);
  if (idMatch) return idMatch;
  const episodeKey = getEpisodeKey(item);
  const episodeMatch = state.releases.find((release) => getEpisodeKey(release) === episodeKey);
  if (episodeMatch) return episodeMatch;
  const seriesKey = getSeriesKey(item);
  return state.releases.find((release) => getSeriesKey(release) === seriesKey);
}

function withCacheBuster(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_=${Date.now()}`;
}

function getCurrentSeason() {
  const m = new Date().getMonth() + 1;
  const y = new Date().getFullYear();
  return { season: m <= 3 ? "winter" : m <= 6 ? "spring" : m <= 9 ? "summer" : "fall", year: y };
}

function getNextSeason({ season, year }) {
  const map = { winter: "spring", spring: "summer", summer: "fall", fall: "winter" };
  return { season: map[season], year: season === "fall" ? year + 1 : year };
}

async function fetchAnimeSeason(season, year, timezone, token) {
  const params = new URLSearchParams({ season, year, tz: timezone });
  const directUrl = `${API_BASE}/anime?${params}&api_token=${encodeURIComponent(token)}`;
  const errors = [];

  async function tryFetch(name, fetchFn, passThroughStatuses = []) {
    try {
      const res = await fetchFn();
      const text = await res.text();
      const t = text.trimStart();
      const isJson = t.startsWith("{") || t.startsWith("[");
      if (passThroughStatuses.includes(res.status) && isJson) {
        return new Response(text, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (!res.ok) { errors.push(`${name}:${res.status}:${text.slice(0, 80)}`); return null; }
      if (!isJson) { errors.push(`${name}:no-json`); return null; }
      return new Response(text, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (e) { errors.push(`${name}:${(e.message || "error").slice(0, 40)}`); return null; }
  }

  const sameOriginResult = await tryFetch("api", () => fetch(`/api/anime?${params}&api_token=${encodeURIComponent(token)}`), [404]);
  if (sameOriginResult) return sameOriginResult;

  const result =
    await tryFetch("direct", () => fetch(directUrl), [404]) ||
    await tryFetch("corsproxy", () => fetch(`https://corsproxy.io/?url=${encodeURIComponent(directUrl)}`)) ||
    await tryFetch("codetabs", () => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(directUrl)}`)) ||
    await tryFetch("allorigins", () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`));

  if (!result) throw new Error(`Sin conexión con AnimeSchedule (${errors.join(" | ")}).`);
  return result;
}

async function fetchTimetable(weekInfo, timezone, token) {
  const params = new URLSearchParams({ year: weekInfo.year, week: weekInfo.week, tz: timezone });
  const urlWithToken = `${API_BASE}/timetables?${params}&api_token=${encodeURIComponent(token)}`;
  const errors = [];

  // Reads response, validates it's JSON, returns buffered Response or null.
  // passThroughStatuses: status codes to return as-is (if body is JSON) without treating as error.
  async function tryFetch(name, fetchFn, passThroughStatuses = []) {
    try {
      const res = await fetchFn();
      const text = await res.text();
      const t = text.trimStart();
      const isJson = t.startsWith("{") || t.startsWith("[");
      if (passThroughStatuses.includes(res.status) && isJson) {
        return new Response(text, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (!res.ok) { errors.push(`${name}:${res.status}:${text.slice(0, 80)}`); return null; }
      if (!isJson) { errors.push(`${name}:no-json`); return null; }
      return new Response(text, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (e) { errors.push(`${name}:${(e.message || "error").slice(0, 40)}`); return null; }
  }

  // 1. Same-origin API route (Vercel deployment) 窶・no CORS, works for everyone automatically.
  //    Pass 404 through: AnimeSchedule uses it to signal a week has no data yet.
  const sameOriginResult = await tryFetch("api", () => fetch(`/api/timetable?${params}&api_token=${encodeURIComponent(token)}`), [404]);
  if (sameOriginResult) return sameOriginResult;

  // 2. Public CORS proxies as last resort
  const result =
    await tryFetch("direct", () => fetch(urlWithToken)) ||
    await tryFetch("corsproxy", () => fetch(`https://corsproxy.io/?url=${encodeURIComponent(urlWithToken)}`)) ||
    await tryFetch("codetabs", () => fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(urlWithToken)}`)) ||
    await tryFetch("allorigins", () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(urlWithToken)}`));

  if (!result) throw new Error(`Sin conexión con AnimeSchedule (${errors.join(" | ")}).`);
  return result;
}

function getFriendlyFetchError(error) {
  if (/(:401|Unauthorized)/i.test(error.message || "")) {
    return "AnimeSchedule rechazo el token. Comprueba que has pegado un API token valido.";
  }
  if (/(:403|Forbidden)/i.test(error.message || "")) {
    return "AnimeSchedule bloqueo la peticion. Revisa el token o el backend local.";
  }
  if (error instanceof TypeError && /fetch/i.test(error.message || "")) {
    return "No se pudo conectar con AnimeSchedule. Comprueba tu conexión a Internet e inténtalo de nuevo.";
  }
  return error.message || "No se pudo actualizar horarios.";
}

function extractArray(data) { if (Array.isArray(data)) return data; if (Array.isArray(data.data)) return data.data; if (Array.isArray(data.timetables)) return data.timetables; if (Array.isArray(data.anime)) return data.anime; return []; }

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
    out.push(sanitizePlatformFields({
      id: stableId("schedule", title, episodeNumber, releaseDate),
      animeKey: stableId(title),
      title,
      route: item.route || "",
      episode: `Ep ${episodeNumber}`,
      episodeNumber,
      airType: "SUB",
      delayed: isDelayed(item),
      releaseDate: new Date(releaseDate).toISOString(),
      originalReleaseDate: item.originalReleaseDate || item.original_release_date || item.scheduledDate || item.scheduled_date || item.expectedDate || item.expected_date || "",
      service: best?.service || "No legal platform",
      serviceUrl: hasAllowedPlatform ? normalizeUrl(best.url || "") : "",
      allServices: allowed.map((stream) => stream.service),
      hasAllowedPlatform,
      source: "animeschedule-api",
      favorite: false,
      coverUrl: buildCoverUrl(item),
      customUrl: "",
      customPlatformName: ""
    }));
  }
  return dedupeByEpisode(out);
}

function getStreams(item) { if (Array.isArray(item.streams)) return item.streams; if (Array.isArray(item.websites?.streams)) return item.websites.streams; if (Array.isArray(item.website?.streams)) return item.website.streams; return []; }
function normalizeStream(stream) { const platform = String(stream.platform || stream.name || "").toLowerCase(); const service = platformToService(platform); return { platform, service, url: stream.url || "" }; }
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
  if (v.includes("hbo") || v.includes("hbomax") || (v === "max")) return "Max";
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
function chooseBestStream(streams) { return [...streams].sort((a,b) => (SERVICE_PRIORITY[a.service] || 50) - (SERVICE_PRIORITY[b.service] || 50))[0] || null; }
function normalizeAllowedService(service) { const mapped = platformToService(String(service || "").toLowerCase()) || String(service || "").trim(); return mapped || ""; }
function sanitizePlatformFields(item) {
  const service = normalizeAllowedService(item.service);
  const allServices = [...new Set((item.allServices || []).map(normalizeAllowedService).filter(Boolean))];
  return {
    ...item,
    service: service || "No legal platform",
    serviceUrl: service ? normalizeUrl(item.serviceUrl || "") : "",
    allServices,
    hasAllowedPlatform: Boolean(service)
  };
}

function stripAnilistOnlyTiming(item) {
  if (item.source !== "anilist-library") return item;
  return {
    ...item,
    releaseDate: "",
    delayed: false,
    anilistAiringDate: item.anilistAiringDate || item.releaseDate || ""
  };
}

async function verifyPlatformsWithJustWatch() {
  const countryEntry = JUSTWATCH_COUNTRIES.find((c) => c.code === state.jwCountry) || JUSTWATCH_COUNTRIES[0];
  const allSeries = getOneNextPerSeries(state.releases)
    .filter((item) => {
      const service = item.service || "No legal platform";
      return service !== "Crunchyroll" && service !== "No legal platform";
    })
    .slice(0, JUSTWATCH_SEARCH_LIMIT);

  if (!allSeries.length) return { checked: 0, changed: 0, errors: 0 };

  let changed = 0, errors = 0;
  const cache = new Map();
  const limit = 5;
  const batches = [];

  for (let i = 0; i < allSeries.length; i += limit) {
    batches.push(allSeries.slice(i, i + limit));
  }

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(async (item) => {
      const key = getSeriesKey(item);
      if (!cache.has(key)) {
        cache.set(key, await fetchJustWatchAvailabilityWithFallback(item, countryEntry.code, countryEntry.lang));
      }
      return { key, result: cache.get(key) };
    }));

    for (const r of results) {
      if (r.status === "rejected") { errors++; continue; }
      const prev = getAllItems().filter((i) => getSeriesKey(i) === r.value.key && i.service !== "Crunchyroll");
      const wasNoPlatform = prev.every((i) => (i.service || "") === "No legal platform");
      applyJustWatchAvailabilityToSeries(r.value.key, r.value.result);
      const now = getAllItems().filter((i) => getSeriesKey(i) === r.value.key && i.service !== "Crunchyroll");
      const nowNoPlatform = now.every((i) => (i.service || "") === "No legal platform");
      if (wasNoPlatform !== nowNoPlatform) changed++;
    }
  }

  return { checked: allSeries.length, changed, errors };
}

async function fetchJustWatchAvailabilityWithFallback(item, countryCode, language) {
  const strip = (t) => t ? t.replace(/\s*(season|s|part|cour)\s*\d+$/i, "").replace(/\s*\([^)]*\)\s*$/i, "").trim() : "";
  const noArticle = (t) => t ? t.replace(/^(the|a|an|el|la|los|las|le|les|un|una)\s+/i, "").trim() : "";
  const queries = [...new Set([
    item.anilistTitle,
    item.title,
    ...(item.titles || []).slice(0, 3),
    strip(item.anilistTitle),
    strip(item.title),
    noArticle(item.anilistTitle),
    noArticle(item.title),
    noArticle(strip(item.anilistTitle)),
    noArticle(strip(item.title)),
  ].filter(Boolean))];

  for (const query of queries) {
    const result = await fetchJustWatchAvailability(item, countryCode, language, query);
    if (result.verified) return result;
  }

  return { verified: false };
}

async function fetchJustWatchAvailability(item, countryCode = "ES", language = "es", searchQuery = "") {
  const q = searchQuery || item.anilistTitle || item.title;
  const gqlPopular = `query GetSearch($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!, $offerFilter: OfferFilter!) { popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR, sortRandomSeed: 0) { edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear } offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType } } } } }`;
  const gqlSearch = `query GetSearch($query: String!, $country: Country!, $language: Language!, $first: Int!, $offerFilter: OfferFilter!) { searchTitles(query: $query, country: $country, first: $first, filter: { objectTypes: ["SHOW"] }) { edges { node { id objectType content(country: $country, language: $language) { title originalReleaseYear } offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType } } } } }`;

  const buildBody = (gql, vars) => ({
    operationName: "GetSearch",
    variables: vars,
    query: gql
  });

  const locales = [
    { country: countryCode, lang: language },
    { country: countryCode, lang: "en" },
  ];

  const bodies = [];
  for (const loc of locales) {
    bodies.push(buildBody(gqlPopular, { first: 20, filter: { searchQuery: q, objectTypes: ["SHOW"] }, country: loc.country, language: loc.lang, offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] } }));
    bodies.push(buildBody(gqlSearch, { first: 20, query: q, country: loc.country, language: loc.lang, offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] } }));
  }

  const tryFetchJson = async (url, body) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return null;
    return await res.json();
  };

  const findInNodes = (nodes) => {
    if (!nodes || nodes.length === 0) return null;
    const match = findJustWatchMatch(item, nodes);
    if (match) return match;
    const itemTitles = [item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean).map(t => t.toLowerCase().trim());
    for (const node of nodes) {
      const jwTitle = (node.content?.title || "").toLowerCase().trim();
      if (jwTitle && itemTitles.some(t => t.includes(jwTitle) || jwTitle.includes(t))) return node;
    }
    return null;
  };

  try {
    let matchNode = null;
    let offersCountry = countryCode;

    for (const body of bodies) {
      let json = await tryFetchJson("/api/justwatch", body).catch(() => null);
      if (!json) json = await tryFetchJson("https://apis.justwatch.com/graphql", body).catch(() => null);
      if (!json) continue;

      const rawNodes = json.data?.popularTitles || json.data?.searchTitles;
      const nodes = Array.isArray(rawNodes)
        ? rawNodes
        : ((rawNodes?.edges || []).map((edge) => edge.node).filter(Boolean));

      matchNode = findInNodes(nodes);
      if (matchNode) break;
    }

    if (!matchNode && countryCode !== "US") {
      const usBody = buildBody(gqlSearch, { first: 10, query: q, country: "US", language: "en", offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] } });
      let json = await tryFetchJson("/api/justwatch", usBody).catch(() => null);
      if (!json) json = await tryFetchJson("https://apis.justwatch.com/graphql", usBody).catch(() => null);
      if (json) {
        const rawNodes = json.data?.popularTitles || json.data?.searchTitles;
        const nodes = Array.isArray(rawNodes)
          ? rawNodes
          : ((rawNodes?.edges || []).map((edge) => edge.node).filter(Boolean));
        const usNode = findInNodes(nodes);
        if (usNode && usNode.id) {
          const gqlOffers = `query GetOffers($id: ID!, $country: Country!, $offerFilter: OfferFilter!) { node(id: $id) { ... on Show { offers(country: $country, platform: WEB, filter: $offerFilter) { package { clearName shortName technicalName } standardWebURL monetizationType } } } }`;
          const offBody = { operationName: "GetOffers", variables: { id: usNode.id, country: countryCode, offerFilter: { bestOnly: false, monetizationTypes: ["FLATRATE", "FREE", "ADS"] } }, query: gqlOffers };
          let offJson = await tryFetchJson("/api/justwatch", offBody).catch(() => null);
          if (!offJson) offJson = await tryFetchJson("https://apis.justwatch.com/graphql", offBody).catch(() => null);
          if (offJson?.data?.node) {
            matchNode = { content: usNode.content, offers: offJson.data.node.offers || [] };
          }
        }
      }
    }

    if (!matchNode) return { verified: false };

    const availability = getJustWatchAllowedAvailability(matchNode);
    if (availability) return { verified: true, availability };
    return { verified: false };
  } catch (error) {
    console.warn("No se pudo verificar JustWatch.", error);
    return { verified: false };
  }
}

function findJustWatchMatch(item, nodes) {
  const itemTitles = [...new Set([item.title, item.anilistTitle, ...(item.titles || [])].filter(Boolean))];
  const itemYear = item.releaseDate ? new Date(item.releaseDate).getFullYear() : null;
  let best = null, bestScore = 0;
  for (const node of nodes) {
    const jwTitle = node.content?.title || "";
    if (!jwTitle) continue;
    let score = Math.max(...itemTitles.map((t) => titleSimilarityScore(t, jwTitle)));
    if (score > 0 && itemYear) {
      const jwYear = node.content?.originalReleaseYear;
      if (jwYear && Math.abs(jwYear - itemYear) <= 1) score = Math.min(1, score + 0.05);
      else if (jwYear && Math.abs(jwYear - itemYear) > 3) score *= 0.85;
    }
    if (score > bestScore) { bestScore = score; best = node; }
  }
  return bestScore >= 0.85 ? best : null;
}

function getJustWatchAllowedAvailability(node) {
  const offers = (node.offers || []).filter((offer) => {
    const mt = String(offer.monetizationType || "").toUpperCase();
    return mt === "FLATRATE" || mt === "FREE" || mt === "ADS";
  });
  const mapped = offers
    .map((offer) => {
      const service = justWatchOfferToService(offer);
      return service ? { service, url: offer.standardWebURL || "" } : null;
    })
    .filter(Boolean);
  const best = chooseBestStream(mapped);
  if (!best) return null;
  const allServices = [...new Set(mapped.map((m) => m.service))];
  const urls = {};
  for (const m of mapped) {
    if (!urls[m.service]) urls[m.service] = m.url;
  }
  return { service: best.service, allServices, urls, hasAllowedPlatform: true };
}

function justWatchOfferToService(offer) {
  const pkg = offer.package || {};
  const clearName = (pkg.clearName || "").trim();
  const haystack = `${clearName} ${pkg.shortName || ""} ${pkg.technicalName || ""} ${offer.standardWebURL || ""}`.toLowerCase();
  const mapped = platformToService(clearName.toLowerCase()) || platformToService(haystack);
  return mapped || "";
}

function applyJustWatchAvailabilityToSeries(seriesKey, result) {
  const availability = result?.verified ? result.availability : null;
  const applyTo = (item) => {
    if (getSeriesKey(item) !== seriesKey) return item;
    const currentService = item.service || "No legal platform";
    if (currentService === "Crunchyroll") return item;
    if (!availability || !availability.allServices.includes(currentService)) {
      return {
        ...item,
        service: "No legal platform",
        serviceUrl: "",
        allServices: [],
        hasAllowedPlatform: false,
        jwVerified: false,
        jwCountry: state.jwCountry
      };
    }
    const jwUrl = availability.urls?.[currentService] || "";
    const newUrl = currentService === "Prime Video" && jwUrl ? jwUrl : item.serviceUrl;
    return {
      ...item,
      service: currentService,
      serviceUrl: newUrl,
      allServices: availability.allServices,
      hasAllowedPlatform: true,
      jwVerified: true,
      jwCountry: state.jwCountry
    };
  };
  state.releases = state.releases.map(applyTo);
  state.anilistLibrary = state.anilistLibrary.map(applyTo);
}
function isDelayed(item) {
  const status = String(item.delayedTimetable || item.subDelayedTimetable || item.status || item.airingStatus || "").trim().toLowerCase();
  const releaseAt = Date.parse(item.episodeDate || item.episode_date || item.airDate || item.air_date || item.releaseDate || item.release_date || "");
  const originalAt = parseRealDate(item.originalReleaseDate || item.original_release_date || item.scheduledDate || item.scheduled_date || item.expectedDate || item.expected_date);
  const changedDay = isLaterCalendarDay(releaseAt, originalAt) ||
    isActiveDelayRange(releaseAt, item.delayedFrom, item.delayedUntil) ||
    isActiveDelayRange(releaseAt, item.subDelayedFrom, item.subDelayedUntil) ||
    isActiveDelayRange(releaseAt, item.delayed_from, item.delayed_until) ||
    isActiveDelayRange(releaseAt, item.sub_delayed_from, item.sub_delayed_until);
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
  return getDateKeyInZone(new Date(time), getSelectedTimezone());
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
  const tz = getSelectedTimezone();
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
function buildCoverUrl(item) { const direct = [item.image, item.imageUrl, item.coverUrl, item.poster, item.posterUrl, item.coverImage, item.thumbnail, item.thumbnailUrl].filter(Boolean).map(normalizeUrl).find(Boolean); if (direct) return direct; const route = String(item.imageVersionRoute || "").trim(); return route ? `${IMAGE_BASE}${route}` : ""; }

function enrichScheduleItem(item) {
  const key = getAnimeKey(item);
  const match = findAnilistMatch(item);
  const hasAllowedPlatform = item.hasAllowedPlatform !== false;
  const matchHasPlatform = Boolean(match?.hasAllowedPlatform && match?.service && match.service !== "AniList");
  const override = match ? getAnilistOverride(item, match) : {};
  return sanitizePlatformFields({
    ...item,
    ...override,
    favorite: Boolean(item.favorite || match?.favorite || state.anilistLibrary.some((anime) => getAnimeKey(anime) === key)),
    anilistId: match?.anilistId || item.anilistId,
    anilistTitle: match?.title || item.anilistTitle,
    anilistUrl: match?.siteUrl || item.anilistUrl,
    anilistScore: match?.anilistScore ?? item.anilistScore,
    coverUrl: match?.coverUrl || item.coverUrl,
    service: override.service || (hasAllowedPlatform ? item.service : (matchHasPlatform ? match.service : "No legal platform")),
    serviceUrl: override.serviceUrl ?? (hasAllowedPlatform ? item.serviceUrl : (matchHasPlatform ? match.serviceUrl : "")),
    allServices: override.allServices || (hasAllowedPlatform ? item.allServices : (matchHasPlatform ? match.allServices : item.allServices)),
    hasAllowedPlatform: override.hasAllowedPlatform ?? (hasAllowedPlatform || matchHasPlatform),
    customUrl: state.customLinks[key] || item.customUrl || "",
    customPlatformName: state.customPlatforms[key] || item.customPlatformName || ""
  });
}

async function fetchAnilistLibrary(username) {
  const query = `query ($userName: String) { MediaListCollection(userName: $userName, type: ANIME) { lists { entries { status progress media { id title { romaji english native } synonyms coverImage { large medium } siteUrl episodes status averageScore meanScore nextAiringEpisode { episode airingAt } externalLinks { site url type } streamingEpisodes { site url title thumbnail } } } } } }`;
  let response;
  try {
    response = await postAnilistGraphql(query, { userName: username });
  } catch (e) {
    throw new Error("No se pudo conectar con AniList. Comprueba tu conexión a Internet.");
  }
  if (!response.ok) throw new Error(getAnilistResponseError(response.status));
  let json;
  try { json = await response.json(); } catch (_) {
    throw new Error("AniList devolvió una respuesta no válida.");
  }
  if (json.errors?.length) throw new Error(json.errors[0].message || "AniList devolvió error");
  return (json.data?.MediaListCollection?.lists || []).flatMap((list) => list.entries || []).filter((entry) => {
    const media = entry.media;
    return entry.status === "CURRENT" && media?.status === "RELEASING" && Boolean(media?.nextAiringEpisode?.airingAt);
  }).map((entry) => {
    const media = entry.media;
    const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);
    const title = media.title?.english || media.title?.romaji || media.title?.native || "Sin título";
    const streams = getAnilistStreams(media);
    const best = chooseBestStream(streams);
    return sanitizePlatformFields({
      id: `anilist-${media.id}`,
      animeKey: stableId(title),
      title,
      titles,
      episode: `Ep ${media.nextAiringEpisode.episode}`,
      episodeNumber: media.nextAiringEpisode.episode,
      airType: "SUB",
      delayed: false,
      releaseDate: "",
      anilistAiringDate: new Date(media.nextAiringEpisode.airingAt * 1000).toISOString(),
      service: best?.service || "No legal platform",
      serviceUrl: best?.url || "",
      allServices: streams.map((stream) => stream.service),
      hasAllowedPlatform: Boolean(best),
      source: "anilist-library",
      favorite: true,
      coverUrl: media.coverImage?.large || media.coverImage?.medium || "",
      anilistId: media.id,
      anilistUrl: media.siteUrl || "",
      anilistScore: normalizeAnilistScore(media.averageScore, media.meanScore),
      totalEpisodes: media.episodes || null,
      customUrl: "",
      customPlatformName: ""
    });
  });
}

function normalizeAnilistScore(...scores) {
  const value = scores.map(Number).find((score) => Number.isFinite(score) && score > 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function enrichReleasesFromPublicAnilist() {
  const catalog = await fetchPublicAnilistCatalog();
  for (const item of getOneNextPerSeries(state.releases)) {
    const media = findPublicAnilistCatalogMatch(item, catalog);
    if (media) applyPublicAnilistDataToSeries(getSeriesKey(item), media);
  }
  await enrichMissingScoresBySearch();
  await enrichMissingScoresByIds();
}

async function enrichMissingScoresBySearch() {
  const candidates = getOneNextPerSeries(state.releases);
  const cache = new Map();

  for (const item of candidates) {
    const key = getSeriesKey(item);
    if (!cache.has(key)) cache.set(key, await fetchPublicAnilistSearchMatch(item));
    const media = cache.get(key);
    if (media) applyPublicAnilistDataToSeries(key, media);
  }
}

async function fetchPublicAnilistSearchMatch(item) {
  const query = `query ($search: String) { Media(search: $search, type: ANIME) { id title { romaji english native } synonyms format coverImage { large medium } siteUrl episodes status averageScore meanScore nextAiringEpisode { episode airingAt } externalLinks { site url type } streamingEpisodes { site url title thumbnail } } }`;
  const search = item.anilistTitle || item.title;
  try {
    const response = await postAnilistGraphql(query, { search });
    if (!response.ok) return null;
    let json;
    try { json = await response.json(); } catch (_) { return null; }
    const media = json.data?.Media;
    if (!media) return null;
    const mapped = mapPublicAnilistMedia(media);
    const score = Math.max(...(mapped.titles || [mapped.title]).map((title) => titleSimilarityScore(item.title, title)));
    return score >= 0.7 ? mapped : null;
  } catch (error) {
    console.warn("No se pudo buscar nota en AniList.", error);
    return null;
  }
}

async function enrichMissingScoresByIds() {
  const seriesMap = new Map();
  for (const item of state.releases) {
    if (!Number.isFinite(item.anilistId) || item.anilistId <= 0) continue;
    if (item.anilistScore != null) continue;
    const key = getSeriesKey(item);
    if (!seriesMap.has(key)) seriesMap.set(key, item.anilistId);
  }

  const uniqueIds = [...new Set(seriesMap.values())];
  if (!uniqueIds.length) return;

  const idToKeys = new Map();
  for (const [seriesKey, anilistId] of seriesMap) {
    if (!idToKeys.has(anilistId)) idToKeys.set(anilistId, []);
    idToKeys.get(anilistId).push(seriesKey);
  }

  const chunkSize = 50;
  let enriched = 0;

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    try {
      const query = "query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { id averageScore meanScore } } }";
      const response = await postAnilistGraphql(query, { ids: chunk });
      if (!response.ok) continue;
      const json = await response.json().catch(() => null);
      const mediaList = json?.data?.Page?.media || [];

      for (const media of mediaList) {
        const score = normalizeAnilistScore(media.averageScore, media.meanScore);
        if (score == null) continue;
        const keys = idToKeys.get(media.id);
        if (!keys) continue;
        for (const seriesKey of keys) {
          state.releases = state.releases.map((item) => {
            if (getSeriesKey(item) === seriesKey && item.anilistScore == null) {
              return { ...item, anilistScore: score };
            }
            return item;
          });
        }
        enriched += keys.length;
      }
    } catch (error) {
      console.warn("Error en consulta batch de scores AniList:", error);
    }
  }

  if (enriched > 0) {
    await saveAllLists();
    render();
  }
}

async function fetchPublicAnilistCatalog() {
  const seasons = [getCurrentSeason(), getNextSeason(getCurrentSeason())];
  const catalog = [];
  const seen = new Set();
  for (const seasonInfo of seasons) {
    for (let page = 1; page <= 3; page++) {
      const chunk = await fetchAnilistSeasonPage(seasonInfo, page);
      for (const media of chunk.items) {
        if (!media?.anilistId || seen.has(media.anilistId)) continue;
        seen.add(media.anilistId);
        catalog.push(media);
      }
      if (!chunk.hasNextPage) break;
    }
  }
  return catalog;
}

async function fetchAnilistSeasonPage({ season, year }, page) {
  const query = `query ($page: Int, $season: MediaSeason, $year: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } media(type: ANIME, season: $season, seasonYear: $year, status: RELEASING, sort: POPULARITY_DESC) { id title { romaji english native } synonyms format coverImage { large medium } siteUrl episodes status averageScore meanScore nextAiringEpisode { episode airingAt } externalLinks { site url type } streamingEpisodes { site url title thumbnail } } } }`;
  const variables = { page, season: String(season || "").toUpperCase(), year };
  let response;
  try {
    response = await postAnilistGraphql(query, variables);
  } catch (e) {
    throw new Error("No se pudo conectar con AniList. Comprueba tu conexión a Internet.");
  }
  if (!response.ok) throw new Error(getAnilistResponseError(response.status));
  let json;
  try { json = await response.json(); } catch (_) {
    throw new Error("AniList devolvió una respuesta no válida.");
  }
  if (json.errors?.length) throw new Error(json.errors[0].message || "AniList devolvió error");
  return {
    hasNextPage: Boolean(json.data?.Page?.pageInfo?.hasNextPage),
    items: (json.data?.Page?.media || []).map(mapPublicAnilistMedia)
  };
}

async function postAnilistGraphql(query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: payload
  };

  try {
    return await fetch("https://graphql.anilist.co", options);
  } catch (error) {
    console.warn("Conexion directa con AniList no disponible; se intenta proxy local.", error);
  }

  const response = await fetch("/api/anilist", options);
  if (response.status === 404 || response.status === 405) throw new Error("No se pudo conectar con AniList.");
  return response;
}

function getAnilistResponseError(status) {
  if (status === 429) return "AniList está limitando las peticiones. Espera unos minutos y vuelve a sincronizar.";
  return `AniList respondió ${status}`;
}

function findPublicAnilistCatalogMatch(item, catalog) {
  if (item.anilistId) {
    const byId = catalog.find((media) => String(media.anilistId) === String(item.anilistId));
    if (byId) return byId;
  }
  let best = null, bestScore = 0;
  for (const media of catalog) {
    const score = Math.max(...(media.titles || [media.title]).map((title) => titleSimilarityScore(item.title, title)));
    if (score > bestScore) { bestScore = score; best = media; }
  }
  return bestScore >= 0.72 ? best : null;
}

function mapPublicAnilistMedia(media) {
  const title = media.title?.english || media.title?.romaji || media.title?.native || "Sin título";
  const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);
  const streams = getAnilistStreams(media);
  const best = chooseBestStream(streams);
  return sanitizePlatformFields({
    anilistId: media.id,
    title,
    titles,
    coverUrl: media.coverImage?.large || media.coverImage?.medium || "",
    siteUrl: media.siteUrl || "",
    anilistFormat: media.format || "",
    anilistScore: normalizeAnilistScore(media.averageScore, media.meanScore),
    episode: media.nextAiringEpisode?.episode ? `Ep ${media.nextAiringEpisode.episode}` : "",
    episodeNumber: media.nextAiringEpisode?.episode || null,
    releaseDate: media.nextAiringEpisode?.airingAt ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString() : "",
    service: best?.service || "",
    serviceUrl: best?.url || "",
    allServices: streams.map((stream) => stream.service),
    hasAllowedPlatform: Boolean(best)
  });
}

function applyPublicAnilistDataToSeries(seriesKey, media) {
  if (!media) return;
  for (const titleKey of buildTitleKeys(media.titles || [media.title])) state.anilistMap[titleKey] = media;
  state.releases = state.releases.map((item) => {
    if (getSeriesKey(item) !== seriesKey) return item;
    const timing = getPublicAnilistTimingCorrection(item, media);
    return {
      ...item,
      ...timing,
      anilistId: media.anilistId || item.anilistId,
      anilistTitle: media.title || item.anilistTitle,
      anilistUrl: media.siteUrl || item.anilistUrl,
      anilistFormat: media.anilistFormat || item.anilistFormat,
      anilistScore: media.anilistScore ?? item.anilistScore,
      excludeFromSchedule: item.excludeFromSchedule || (String(media.anilistFormat || "").toUpperCase() === "MOVIE" && parseEpisodeNumber(item.episodeNumber ?? item.episode) === 1),
      coverUrl: media.coverUrl || item.coverUrl,
      ...(media.hasAllowedPlatform ? {
        service: media.service,
        serviceUrl: (item.serviceUrl && item.service === media.service) ? item.serviceUrl : (media.serviceUrl || ""),
        allServices: media.allServices || [media.service],
        hasAllowedPlatform: true
      } : {})
    };
  });
}

function getSharedSubReleaseDate(row) {
  const original = row.originalReleaseDate || row.original_release_date || "";
  if (row.correctedByAniList && original && !row.anilistDayCorrection) return original;
  return row.release_date || row.releaseDate || "";
}

function getPublicAnilistTimingCorrection(item, media) {
  const itemEpisode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
  const mediaEpisode = parseEpisodeNumber(media.episodeNumber ?? media.episode);
  const mediaTime = Date.parse(media.releaseDate || "");
  if (!Number.isFinite(mediaEpisode) || !Number.isFinite(mediaTime)) return {};
  const itemTime = Date.parse(item.releaseDate || "");
  if (!Number.isFinite(itemTime)) return {};
  const sameEpisode = Number.isFinite(itemEpisode) && itemEpisode === mediaEpisode;
  const suspiciousPremiere = Number.isFinite(itemEpisode) && itemEpisode === 1 && mediaEpisode > 1 && getSeriesMatchScore(item, media) >= 0.9;
  if (!sameEpisode && !suspiciousPremiere) return {};
  const changedCalendarDay = !isSameCalendarDay(mediaTime, itemTime);
  const correctedDate = changedCalendarDay ? replaceCalendarDayKeepTime(itemTime, mediaTime) : item.releaseDate;
  return {
    ...(suspiciousPremiere ? { episode: media.episode || `Ep ${mediaEpisode}`, episodeNumber: media.episodeNumber ?? mediaEpisode } : {}),
    releaseDate: correctedDate,
    delayed: changedCalendarDay || Boolean(item.delayed),
    originalReleaseDate: changedCalendarDay ? (item.originalReleaseDate || item.releaseDate || "") : (item.originalReleaseDate || ""),
    anilistDayCorrection: changedCalendarDay || Boolean(item.anilistDayCorrection)
  };
}

function getAnilistStreams(media) {
  const externalLinks = (media.externalLinks || [])
    .filter((link) => String(link.type || "").toUpperCase() === "STREAMING")
    .map((link) => normalizeAnilistStream(link.site, link.url));
  const streamingEpisodes = (media.streamingEpisodes || [])
    .map((episode) => normalizeAnilistStream(episode.site, episode.url));
  const seen = new Set();
  return [...externalLinks, ...streamingEpisodes].filter((stream) => {
    if (!stream?.service || !stream.url) return false;
    const key = `${stream.service}|${stream.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAnilistStream(site, url) {
  const name = String(site || "").trim();
  const service = normalizeAllowedService(name);
  return { service, url: normalizeUrl(url || "") };
}

function buildAnilistMap(library) {
  const map = {};
  for (const anime of library) {
    const data = { anilistId: anime.anilistId, title: anime.title, titles: anime.titles || [anime.title], coverUrl: anime.coverUrl, siteUrl: anime.anilistUrl, anilistScore: anime.anilistScore, episode: anime.episode, episodeNumber: anime.episodeNumber, releaseDate: anime.releaseDate || anime.anilistAiringDate || "", anilistAiringDate: anime.anilistAiringDate || anime.releaseDate || "", favorite: true, service: anime.service, serviceUrl: anime.serviceUrl, allServices: anime.allServices, hasAllowedPlatform: anime.hasAllowedPlatform };
    for (const key of buildTitleKeys(data.titles)) map[key] = data;
  }
  return map;
}

function clearStaleAnilistFavorites() {
  const watchingIds = new Set(state.anilistLibrary.map((anime) => String(anime.anilistId)).filter(Boolean));
  const watchingKeys = new Set(state.anilistLibrary.map(getSeriesKey));
  state.releases = state.releases.map((item) => {
    const linkedToAnilist = Boolean(item.anilistId || item.anilistTitle);
    if (!linkedToAnilist) return item;
    const stillWatching = watchingIds.has(String(item.anilistId)) || watchingKeys.has(getSeriesKey(item));
    return stillWatching ? item : { ...item, favorite: false };
  });
}

function reconcileAnilistFavoritesWithSchedule() {
  if (!state.anilistLibrary.length || !state.releases.length) return;
  state.releases = state.releases.map((release) => {
    const match = findAnilistScheduleOwner(release);
    if (!match) return release;
    return {
      ...release,
      favorite: true,
      anilistId: match.anilistId || release.anilistId,
      anilistTitle: match.title || release.anilistTitle,
      anilistUrl: match.anilistUrl || release.anilistUrl,
      anilistScore: match.anilistScore ?? release.anilistScore,
      coverUrl: match.coverUrl || release.coverUrl
    };
  });
}

function findAnilistScheduleOwner(release) {
  let best = null, bestScore = 0;
  for (const anime of state.anilistLibrary) {
    if (anime.anilistId && release.anilistId && String(anime.anilistId) === String(release.anilistId)) return anime;
    const score = getSeriesMatchScore(release, anime);
    if (score > bestScore) { bestScore = score; best = anime; }
  }
  return bestScore >= 0.78 ? best : null;
}

function findAnilistMatch(item) {
  if (item.anilistId) {
    const byId = Object.values(state.anilistMap).find((data) => String(data.anilistId) === String(item.anilistId));
    if (byId) return byId;
  }
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
function importantTokens(v) { const stop = new Set(["the","and","for","with","from","season","part","cour","anime","series","animation","new","episode"]); return String(v||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\p{L}\p{N}]+/gu," ").split(/\s+/).filter(t => t.length >= 3 && !stop.has(t)); }
function diceCoefficient(a,b) { const ba = bigrams(a), bb = bigrams(b); if (!ba.length || !bb.length) return 0; const counts = new Map(); for (const g of ba) counts.set(g, (counts.get(g)||0)+1); let m=0; for (const g of bb) { const c = counts.get(g)||0; if (c>0) { m++; counts.set(g,c-1); } } return (2*m)/(ba.length+bb.length); }
function bigrams(v) { const s=String(v||""); const r=[]; for(let i=0;i<s.length-1;i++) r.push(s.slice(i,i+2)); return r; }
function buildTitleKeys(titles) { const keys = new Set(); for (const title of titles) for (const alias of buildTitleAliases(title)) { const n = normalizeTitle(alias), st = stableId(alias); if(n) keys.add(n); if(st) keys.add(st); } return [...keys]; }
function buildTitleAliases(title) { const v=String(title||""); return [...new Set([v, v.replace(/\s*(season|s)\s*\d+$/i,""), v.replace(/\s*part\s*\d+$/i,""), v.replace(/\s*\([^)]*\)\s*$/i,""), v.replace(/\s*(2nd|3rd|4th|5th|second|third|fourth|fifth)\s+season$/i,""), v.replace(/\s*(cour|part)\s*\d+$/i,""), v.replace(/[:\-]+/g," "), v.replace(/&/g,"and")])].map(x=>x.trim()).filter(Boolean); }

function applyAnilistToReleases() { state.releases = mergeDuplicateItems(state.releases.map(item => { const match = findAnilistMatch(item); if(!match) return item; const override = getAnilistOverride(item, match); return { ...item, ...override, favorite: match.favorite === true ? true : item.favorite, anilistId: match.anilistId, anilistTitle: match.title, anilistUrl: match.siteUrl, anilistScore: match.anilistScore ?? item.anilistScore, coverUrl: match.coverUrl || item.coverUrl }; })); }
function getAnilistOverride(item, match) {
  const nextTime = Date.parse(getAnilistAiringDate(match));
  const itemTime = Date.parse(item.releaseDate || "");
  const itemEpisode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
  const matchEpisode = parseEpisodeNumber(match.episodeNumber ?? match.episode);
  const canOverrideTiming = item.source === "anilist-library";
  const canCorrectScheduleTiming = canApplyAnilistDayCorrection(item, match, itemEpisode, matchEpisode, itemTime, nextTime);
  const matchHasPlatform = Boolean(match.hasAllowedPlatform && match.service && match.service !== "AniList");
  const delayedByDate = (canOverrideTiming || canCorrectScheduleTiming) && !isSameCalendarDay(nextTime, itemTime);
  const correctedReleaseDate = canCorrectScheduleTiming
    ? replaceCalendarDayKeepTime(itemTime, nextTime)
    : (canOverrideTiming && Number.isFinite(nextTime) ? new Date(nextTime).toISOString() : item.releaseDate);
  const override = {
    title: match.title || item.title,
    episode: canOverrideTiming ? (match.episode || item.episode) : item.episode,
    episodeNumber: canOverrideTiming ? (match.episodeNumber ?? item.episodeNumber) : item.episodeNumber,
    releaseDate: correctedReleaseDate,
    delayed: delayedByDate || Boolean(item.delayed),
    originalReleaseDate: delayedByDate ? (item.originalReleaseDate || item.releaseDate || "") : (item.originalReleaseDate || ""),
    anilistDayCorrection: canCorrectScheduleTiming || Boolean(item.anilistDayCorrection),
    source: item.source === "shared-json" ? "shared-json+anilist" : item.source
  };
  if (matchHasPlatform) {
    override.service = match.service;
    override.serviceUrl = match.serviceUrl || "";
    override.allServices = match.allServices || [match.service];
    override.hasAllowedPlatform = true;
  } else if (item.hasAllowedPlatform === false) {
    override.service = "No legal platform";
    override.serviceUrl = "";
    override.hasAllowedPlatform = false;
  }
  return override;
}
function getAnilistAiringDate(match) {
  return match?.releaseDate || match?.anilistAiringDate || "";
}
function canApplyAnilistDayCorrection(item, match, itemEpisode, matchEpisode, itemTime, nextTime) {
  if (!match || item.source === "anilist-library") return false;
  if (!String(item.source || "").startsWith("shared-json") && item.source !== "animeschedule-api") return false;
  if (!Number.isFinite(itemEpisode) || !Number.isFinite(matchEpisode) || itemEpisode !== matchEpisode) return false;
  if (!Number.isFinite(itemTime) || !Number.isFinite(nextTime) || isSameCalendarDay(itemTime, nextTime)) return false;
  return getSeriesMatchScore(item, match) >= 0.78;
}
function parseEpisodeNumber(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}
function applyCustomToReleases() { state.releases = state.releases.map(applyCustom); state.anilistLibrary = state.anilistLibrary.map(applyCustom); }
function applyCustom(item) { const key=getAnimeKey(item); const customUrl=normalizeUrl(state.customLinks[key] || item.customUrl || ""); const customPlatformName=state.customPlatforms[key] || item.customPlatformName || ""; return { ...item, customUrl, customPlatformName }; }
function sanitizeCustomPlatformStorage() {
  for (const key of Object.keys(state.customPlatforms)) {
    const service = normalizeAllowedService(state.customPlatforms[key]);
    if (service) {
      state.customPlatforms[key] = service;
    } else {
      delete state.customPlatforms[key];
      delete state.customLinks[key];
    }
  }
}

async function saveSanitizedState() {
  await browserApi.storage.local.set({
    releases: state.releases,
    anilistLibrary: state.anilistLibrary,
    customPlatforms: state.customPlatforms,
    customLinks: state.customLinks
  });
}

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

function handleListAuxClick(event) {
  if (event.button !== 1) return;
  const card = event.target.closest(".anime-card");
  if (!card) return;
  event.preventDefault();
  const item = findItemById(card.dataset.id);
  if (!item) return;
  const url = getBestWatchUrl(item);
  if (url) window.open(url, "_blank", "noopener");
}

async function toggleFavorite(key) {
  const should = !getAllItems().some(item => getAnimeKey(item) === key && item.favorite);
  state.releases = state.releases.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item);
  state.anilistLibrary = state.anilistLibrary.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item);
  await saveAllLists();

  if (isCapacitor() && state.notificationEnabled) {
    cancelStaleNativeNotifications();
    scheduleNativeNotifications();
  }

  const btn = els.animeList.querySelector(`[data-action="favorite"][data-key="${CSS.escape(key)}"]`);

  if (!should && (state.viewMode === "favorites" || state.viewMode === "today")) {
    const card = btn?.closest(".anime-card");
    if (card) card.remove();
    if (!els.animeList.querySelector(".anime-card")) render();
    renderNextModern();
    return;
  }

  if (btn) {
    btn.className = `favorite-btn ${should ? "favorite" : "add"}`;
    btn.setAttribute("aria-label", should ? "Quitar de favoritos" : "Añadir a favoritos");
    btn.innerHTML = should
      ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : "+";
    if (should) {
      btn.classList.add("pop");
    }
  }
  renderNextModern();
}
async function associatePlatform(key) { const sample = findItemByKey(key); const name = prompt("Nombre de la plataforma que quieres mostrar:", state.customPlatforms[key] || sample?.customPlatformName || "Crunchyroll"); if (name === null) return; const cleanName = normalizeAllowedService(name.trim()); if(!cleanName) return showStatus("Escribe un nombre de plataforma.", "warn"); const url = prompt(`Pega el enlace para ${cleanName}:`, state.customLinks[key] || sample?.customUrl || ""); if (url === null) return; const cleanUrl = normalizeUrl(url.trim()); if(!cleanUrl) return showStatus("Link inválido.", "warn"); state.customPlatforms[key]=cleanName; state.customLinks[key]=cleanUrl; await browserApi.storage.local.set({ customPlatforms: state.customPlatforms, customLinks: state.customLinks }); applyCustomToReleases(); await saveAllLists(); render(); showStatus(`Plataforma "${cleanName}" asociada.`, "success"); }
async function removePlatform(key) { delete state.customPlatforms[key]; delete state.customLinks[key]; await browserApi.storage.local.set({ customPlatforms: state.customPlatforms, customLinks: state.customLinks }); state.releases = state.releases.map(item => getAnimeKey(item) === key ? { ...item, customUrl:"", customPlatformName:"" } : item); state.anilistLibrary = state.anilistLibrary.map(item => getAnimeKey(item) === key ? { ...item, customUrl:"", customPlatformName:"" } : item); await saveAllLists(); render(); }

async function openOrAsk(item) { const displayService = getDisplayService(item); const url = getBestWatchUrl(item, displayService); if (url) { browserApi.tabs.create({ url }); return; } const ok = confirm(`No hay plataforma asociada para "${item.title}". ¿Quieres asociar un link ahora?`); if (ok) await associatePlatform(getAnimeKey(item)); }
async function resetAll() {
  if (!confirm("¿Seguro que quieres borrar todos tus favoritos?")) return;
  state.releases = state.releases.map(item => ({ ...item, favorite: false }));
  state.anilistLibrary = state.anilistLibrary.map(item => ({ ...item, favorite: false }));
  await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary });
  render();
  showStatus("Favoritos borrados.", "success");
}

function startNotificationScheduler() {
  checkReleaseNotifications();
  if (isCapacitor()) {
    setTimeout(async () => {
      await cancelStaleNativeNotifications();
      await scheduleNativeNotifications();
    }, 3000);
  }
  setInterval(() => {
    if (document.visibilityState === "visible") checkReleaseNotifications();
  }, VISIBLE_NOTIFICATION_CHECK_MS);
  scheduleQuarterHourNotificationCheck();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkReleaseNotifications();
      scheduleQuarterHourNotificationCheck();
    }
  });
  window.addEventListener("focus", () => checkReleaseNotifications());
}

function scheduleQuarterHourNotificationCheck() {
  clearTimeout(quarterNotificationTimer);
  const delay = getDelayToNextQuarterHour();
  quarterNotificationTimer = setTimeout(() => {
    checkReleaseNotifications();
    setTimeout(checkReleaseNotifications, 5000);
    scheduleQuarterHourNotificationCheck();
  }, delay);
}

function getDelayToNextQuarterHour(date = new Date()) {
  const next = new Date(date);
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  const quarterMinutes = QUARTER_HOUR_MS / 60000;
  const nextQuarter = Math.ceil((minute + 0.001) / quarterMinutes) * quarterMinutes;
  if (nextQuarter >= 60) {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  } else {
    next.setMinutes(nextQuarter, 0, 0);
  }
  return Math.max(1000, next.getTime() - date.getTime());
}

async function checkReleaseNotifications() {
  if (!state.notificationEnabled) return;
  if (!isCapacitor() && (!("Notification" in window) || Notification.permission !== "granted")) return;
  const now = Date.now();
  const favorites = getFavoriteItems();
  const candidates = getDueNotificationItems(favorites.length ? favorites : state.releases, now);
  let changed = false;

  for (const item of candidates) {
    const releaseAt = new Date(item.releaseDate).getTime();
    if (!Number.isFinite(releaseAt)) continue;
    const diff = releaseAt - now;
    if (diff > NOTIFICATION_LEAD_MS || diff < -NOTIFICATION_GRACE_MS) continue;
    const key = `${item.id}|${new Date(item.releaseDate).toISOString()}`;
    if (state.notifiedReleaseIds[key]) continue;

    state.notifiedReleaseIds[key] = true;
    changed = true;
    await showReleaseNotification(item);
  }

  if (changed) await browserApi.storage.local.set({ notifiedReleaseIds: state.notifiedReleaseIds });
}

function getDueNotificationItems(items, now = Date.now()) {
  const due = items.filter((item) => {
    const releaseAt = new Date(item.releaseDate).getTime();
    if (!Number.isFinite(releaseAt)) return false;
    const diff = releaseAt - now;
    return diff <= NOTIFICATION_LEAD_MS && diff >= -NOTIFICATION_GRACE_MS;
  });
  return sortByDate(dedupeNotificationItems(due));
}

function dedupeNotificationItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.id || getEpisodeKey(item);
    const current = map.get(key);
    if (!current || scoreItem(item) > scoreItem(current)) map.set(key, item);
  }
  return [...map.values()];
}

async function showReleaseNotification(item) {
  const title = `${item.title} ${item.episode}`;
  const displayService = getDisplayService(item);
  const body = displayService === "No legal platform" ? "Ya disponible." : `Ya disponible en ${displayService}.`;
  const url = getBestWatchUrl(item, displayService) || location.href;
  const coverUrl = normalizeUrl(item.coverUrl);
  const fallbackIcon = toAbsoluteUrl("./icons/icon-192.png");
  const badgeIcon = toAbsoluteUrl("./icons/notification-badge.svg");
  const options = {
    body,
    icon: coverUrl || fallbackIcon,
    image: coverUrl || undefined,
    badge: badgeIcon,
    tag: `anime-${item.id}`,
    renotify: true,
    requireInteraction: true,
    timestamp: new Date(item.releaseDate).getTime(),
    data: { url }
  };

  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return;
    }
  } catch (error) {
    console.warn("No se pudo mostrar la notificacion desde el service worker.", error);
  }

  new Notification(title, options);
}

function getLocalNotifications() {
  try {
    if (typeof Capacitor === "undefined") return null;
    if (!Capacitor.isNativePlatform()) return null;
    if (!Capacitor.Plugins || !Capacitor.Plugins.LocalNotifications) return null;
    return Capacitor.Plugins.LocalNotifications;
  } catch (_) { return null; }
}

function isCapacitor() {
  try {
    return typeof Capacitor !== "undefined" && Capacitor.isNativePlatform();
  } catch (_) { return false; }
}

async function scheduleNativeNotifications() {
  if (!isCapacitor() || !state.notificationEnabled) return;
  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) return;

  try {
    const allPending = await LocalNotifications.getPending();
    const pendingIds = new Set(allPending.notifications.map((n) => n.id));

    const now = Date.now();
    const favorites = state.releases.filter((item) => item.favorite);
    const toSchedule = [];

    for (const item of favorites) {
      const releaseAt = new Date(item.releaseDate).getTime();
      if (!Number.isFinite(releaseAt) || releaseAt <= now) continue;
      if (releaseAt > now + 7 * 24 * 3600 * 1000) continue;
      const notifId = hashNotificationId(item);
      if (pendingIds.has(notifId)) continue;

      const displayService = getDisplayService(item);
      const coverUrl = normalizeUrl(item.coverUrl);
      let localPath = null;
      if (coverUrl) {
        localPath = await downloadCoverImage(coverUrl, notifId);
      }
      toSchedule.push({
        id: notifId,
        title: `${item.title} ${item.episode}`,
        body: displayService === "No legal platform" ? "Ya disponible." : `Ya disponible en ${displayService}.`,
        schedule: { at: new Date(releaseAt) },
        extra: { url: getBestWatchUrl(item, displayService) || location.href, title: item.title },
        smallIcon: "ic_stat_icon",
        largeIcon: localPath || undefined,
        iconColor: "#111827",
        actionTypeId: "",
        attachments: localPath ? [{ id: "cover", url: localPath }] : null,
        group: "anime-countdown",
        groupSummary: false
      });
    }

    if (toSchedule.length) {
      await LocalNotifications.schedule({ notifications: toSchedule });
    }
    return toSchedule.length;
  } catch (error) {
    console.warn("Error al programar notificaciones nativas:", error);
    return 0;
  }
}

async function cancelStaleNativeNotifications() {
  if (!isCapacitor()) return;
  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) return;
  try {
    const pending = await LocalNotifications.getPending();
    const validIds = new Set();
    const now = Date.now();
    const favorites = state.releases.filter((item) => item.favorite);
    for (const item of favorites) {
      const releaseAt = new Date(item.releaseDate).getTime();
      if (Number.isFinite(releaseAt) && releaseAt > now) {
        validIds.add(hashNotificationId(item));
      }
    }
    const toCancel = pending.notifications.filter((n) => !validIds.has(n.id));
    if (toCancel.length) {
      await LocalNotifications.cancel({ notifications: toCancel });
    }
  } catch (error) {
    console.warn("Error al limpiar notificaciones nativas:", error);
  }
}

async function downloadCoverImage(url, notifId) {
  try {
    if (!isCapacitor()) return null;
    if (!Capacitor.Plugins || !Capacitor.Plugins.Filesystem) return null;
    const Filesystem = Capacitor.Plugins.Filesystem;

    const path = "cover-" + notifId + ".jpg";

    const statResult = await Filesystem.stat({ path, directory: "DATA" }).catch(() => ({ exists: false }));
    if (statResult.exists) {
      const uriResult = await Filesystem.getUri({ path, directory: "DATA" });
      return uriResult.uri;
    }

    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = function () {
        var dataUrl = reader.result;
        var idx = dataUrl.indexOf(",");
        resolve(idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl);
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });

    const result = await Filesystem.writeFile({
      path: path,
      data: base64,
      directory: "DATA",
      recursive: true
    });

    return result.uri;
  } catch (error) {
    console.warn("Error al descargar portada:", error);
    return null;
  }
}

function hashNotificationId(item) {
  const key = `${item.id || getEpisodeKey(item)}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2147483647;
}

function setupCapacitorNotificationTap() {
  if (!isCapacitor()) return;
  try {
    const LocalNotifications = getLocalNotifications();
    if (LocalNotifications && LocalNotifications.addListener) {
      LocalNotifications.addListener("localNotificationActionPerformed", (notification) => {
        const extra = notification.notification?.extra;
        if (extra && extra.url) {
          openExternalUrl(extra.url);
        }
      });
    }
  } catch (error) {
    console.warn("No se pudo configurar el tap de notificaciones.", error);
  }
}

function toAbsoluteUrl(url) {
  try {
    return new URL(url, location.href).href;
  } catch (error) {
    return url;
  }
}

function render() { setActiveTab(); renderNextModern(); renderListModern(); renderSettingsPlatformFilter(); }
function updateLiveCountdowns() {
  if (state.currentNext) {
    const c = getCountdown(state.currentNext.releaseDate);
    const nextCountdown = els.nextRelease.querySelector(".next-countdown");
    if (nextCountdown) nextCountdown.textContent = c.text;
    if (c.expired) {
      if (state.viewMode === "all" || state.viewMode === "favorites") {
        render();
        return;
      }
      renderNextModern();
    }
  }
  els.animeList.querySelectorAll(".anime-card").forEach((card) => {
    const item = findItemById(card.dataset.id);
    const countdown = card.querySelector(".countdown");
    if (item && countdown) countdown.textContent = getCountdown(item.releaseDate).text;
  });
}

function scheduleMidnightRefresh() {
  try {
    const tz = getSelectedTimezone();
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0") % 24;
    const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
    const s = parseInt(parts.find((p) => p.type === "second")?.value || "0");
    const msUntilMidnight = 86400000 - (h * 3600 + m * 60 + s) * 1000;
    setTimeout(() => {
      if (state.viewMode === "today") render();
      scheduleMidnightRefresh();
    }, msUntilMidnight);
  } catch (e) {
    setTimeout(scheduleMidnightRefresh, 3600000);
  }
}
function setActiveTab() { els.showAllBtn.classList.toggle("active", state.viewMode==="all"); els.showTodayBtn.classList.toggle("active", state.viewMode==="today"); els.showFavsBtn.classList.toggle("active", state.viewMode==="favorites"); const modes=["all","today","favorites"]; const idx=modes.indexOf(state.viewMode); const ind=document.querySelector(".tab-indicator"); if(ind){ind.style.transition="transform 280ms var(--ease)";ind.style.transform=`translateX(calc(${idx*100}% + ${idx*8}px))`;} }
function adjustDelayedDates(items) {
  const { year: cy, week: cw } = getIsoWeek(new Date());
  return items.map(item => {
    if (!item.delayed || !item.releaseDate) return item;
    const d = new Date(item.releaseDate);
    if (isNaN(d.getTime())) return item;
    const { year, week } = getIsoWeek(d);
    if (year !== cy || week !== cw) return item;
    const shifted = new Date(d);
    shifted.setUTCDate(shifted.getUTCDate() + 7);
    return { ...item, releaseDate: shifted.toISOString() };
  });
}
function getVisibleItems() { if(state.viewMode==="favorites") return getOneNextPerSeries(adjustDelayedDates(getFavoriteItems())); if(state.viewMode==="today") return sortByDate(adjustDelayedDates(getFavoriteItems()).filter(item => isSchedulableItem(item) && isToday(item.releaseDate))); return getOneNextPerSeries(adjustDelayedDates(getCatalogItems())); }
function getDisplayService(item) {
  const service = item.customPlatformName || item.service || "No legal platform";
  if (service === "No legal platform") return service;
  if (!state.hiddenPlatforms.includes(service)) return service;
  const fallback = (item.allServices || [])
    .filter((s) => s && s !== "No legal platform" && !state.hiddenPlatforms.includes(s))
    .sort((a, b) => (SERVICE_PRIORITY[a] || 50) - (SERVICE_PRIORITY[b] || 50))[0];
  return fallback || "No legal platform";
}
function getFavoriteItems() { return mergeDuplicateItems(state.releases.filter(item => item.favorite)); }
function getCatalogItems() { return mergeDuplicateItems(state.releases); }
function getOneNextPerSeries(items) { const now = new Date(); const groups = new Map(); for(const item of mergeDuplicateItems(items).filter(isSchedulableItem)) { if(!item.releaseDate) continue; const d = new Date(item.releaseDate); if(Number.isNaN(d.getTime()) || d <= now) continue; const key=getSeriesKey(item); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(item); } const result=[]; for(const eps of groups.values()) { const ordered=sortByDate(eps); if(ordered.length) result.push(ordered[0]); } return sortByDate(result); }
function getOneTodayPerSeries(items) { const groups = new Map(); for(const item of mergeDuplicateItems(items)) { if(!item.releaseDate) continue; const d = new Date(item.releaseDate); if(Number.isNaN(d.getTime())) continue; const key=getSeriesKey(item); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(item); } const result=[]; for(const eps of groups.values()) { const ordered=sortByDate(eps); if(ordered.length) result.push(ordered[0]); } return sortByDate(result); }
function getRemainingTodayItems(items) { const now = new Date(); return getOneNextPerSeries(items.filter(item => isSchedulableItem(item) && isToday(item.releaseDate) && new Date(item.releaseDate) > now)); }

function renderCover(item, cls) { const letter=escapeHtml(String(item.title||"?").trim().charAt(0).toUpperCase() || "?"); if(!item.coverUrl) return `<div class="${cls} placeholder">${letter}</div>`; return `<img class="${cls}" src="${escapeHtml(item.coverUrl)}" alt="${escapeHtml(item.title)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls} placeholder&quot;>${letter}</div>'"/>`; }
function renderPreview(items) { if(!els.importPreview) return; const shown=getOneNextPerSeries(items); els.importPreview.innerHTML=""; shown.slice(0,6).forEach(item => { const card=document.createElement("div"); card.className="result-card"; card.innerHTML=`<div class="result-title">${escapeHtml(item.title)}</div><div class="result-meta">${escapeHtml(item.episode)} · ${escapeHtml(item.service)}<br/>${escapeHtml(formatDate(item.releaseDate))}</div>`; els.importPreview.appendChild(card); }); if(shown.length>6) { const more=document.createElement("div"); more.className="empty-message"; more.textContent=`Y ${shown.length-6} más...`; els.importPreview.appendChild(more); } }

function getCountdown(dateValue) { const target=new Date(dateValue), now=new Date(), diff=target-now; if(Number.isNaN(target.getTime())) return { text:"Fecha inválida", expired:true }; if(diff<=0) return { text:"Ya disponible", expired:true }; const s=Math.floor(diff/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60; return { text:`${d}d ${h}h ${m}min ${sec}s`, expired:false }; }
function formatDate(value) { const d=new Date(value); if(Number.isNaN(d.getTime())) return "Sin fecha"; return new Intl.DateTimeFormat("es-ES",{timeZone: getSelectedTimezone(),weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false}).format(d); }
function isToday(value) { const d=new Date(value); if(Number.isNaN(d.getTime())) return false; return getDateKeyInZone(d, getSelectedTimezone()) === getDateKeyInZone(new Date(), getSelectedTimezone()); }
function getSelectedTimezone() { return state.timezone || els.timezoneInput?.value?.trim() || "Europe/Madrid"; }
function getDateKeyInZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function getNextWeeks(amount) { const weeks=[]; const start=new Date(); for(let i=0;i<amount;i++) { const d=new Date(start); d.setDate(start.getDate()+i*7); const iso=getIsoWeek(d); const key=`${iso.year}-${iso.week}`; if(!weeks.some(w=>`${w.year}-${w.week}`===key)) weeks.push(iso); } return weeks; }
function getIsoWeek(date) { const t=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())); const day=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-day); const yStart=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return { year:t.getUTCFullYear(), week:Math.ceil((((t-yStart)/86400000)+1)/7) }; }

function mergeById(a,b) { const map=new Map(); [...a,...b].forEach(item => map.set(item.id, { ...map.get(item.id), ...item })); return [...map.values()]; }
function dedupeByEpisode(items) { return mergeDuplicateItems(items); }
function mergeDuplicateItems(items) { const map=new Map(); for(const item of items) { const key=getEpisodeKey(item); const current=map.get(key); if(!current || scoreItem(item)>scoreItem(current)) map.set(key, mergeItem(item,current)); else map.set(key, mergeItem(current,item)); } return sortByDate([...map.values()]); }
function mergeItem(win, lose={}) { return { ...win, favorite:Boolean(win.favorite||lose.favorite), coverUrl:win.coverUrl||lose.coverUrl||"", serviceUrl:win.serviceUrl||lose.serviceUrl||"", allServices:win.allServices?.length ? win.allServices : (lose.allServices || []), hasAllowedPlatform:Boolean(win.hasAllowedPlatform||lose.hasAllowedPlatform), customUrl:win.customUrl||lose.customUrl||"", customPlatformName:win.customPlatformName||lose.customPlatformName||"", anilistId:win.anilistId||lose.anilistId, anilistTitle:win.anilistTitle||lose.anilistTitle, anilistUrl:win.anilistUrl||lose.anilistUrl, anilistScore:win.anilistScore ?? lose.anilistScore }; }
function scoreItem(item) { let s=0; if(item.customUrl)s+=100; if(item.serviceUrl)s+=85; if(item.service==="Crunchyroll")s+=80; if(item.service==="Netflix")s+=60; if(item.service==="Prime Video")s+=50; if(item.source==="animeschedule-api")s+=40; if(item.coverUrl)s+=10; if(item.favorite)s+=5; if(item.source==="anilist-library")s-=20; return s; }
function sortByDate(items) { return [...items].sort((a,b)=>new Date(a.releaseDate||"9999-12-31")-new Date(b.releaseDate||"9999-12-31")); }
function getEpisodeKey(item) { const ep=item.episodeNumber || String(item.episode||"").replace(/[^0-9]/g,""); const date=item.releaseDate ? new Date(item.releaseDate).toISOString().slice(0,10) : "no-date"; return `${getSeriesKey(item)}|${ep}|${date}`; }
function isSchedulableItem(item) {
  if (item.excludeFromSchedule) return false;
  const ep = parseEpisodeNumber(item.episodeNumber ?? item.episode);
  const haystack = `${item.title || ""} ${item.route || ""} ${item.animeKey || ""} ${item.anilistFormat || ""}`.toLowerCase();
  if (Number.isFinite(ep) && ep === 1 && (haystack.includes("movie") || haystack.includes("gekijouban") || haystack.includes("film"))) return false;
  if (Number.isFinite(ep) && ep === 1 && String(item.anilistFormat || "").toUpperCase() === "MOVIE") return false;
  return true;
}
function getAllItems() { return [...state.releases, ...state.anilistLibrary]; }
function findItemById(id) { return getAllItems().find(item=>item.id===id); }
function findItemByKey(key) { return getAllItems().find(item=>getAnimeKey(item)===key); }
function hasScheduledSeriesMatch(item, scheduledItems = state.releases) {
  return scheduledItems.some((release) => {
    if (getSeriesKey(release) === getSeriesKey(item)) return true;
    return getSeriesMatchScore(release, item) >= 0.78;
  });
}
function getSeriesMatchScore(a, b) {
  if (a.anilistId && b.anilistId && String(a.anilistId) === String(b.anilistId)) return 1;
  const aTitles = [a.title, a.anilistTitle, a.route, a.animeKey, ...(a.titles || [])].filter(Boolean);
  const bTitles = [b.title, b.anilistTitle, b.route, b.animeKey, ...(b.titles || [])].filter(Boolean);
  let best = 0;
  for (const left of aTitles) for (const right of bTitles) best = Math.max(best, titleSimilarityScore(left, right));
  return best;
}
function getAnimeKey(item) { return stableId(item.animeKey || item.route || item.title); }
function getSeriesKey(item) { return stableId(item.anilistId || item.anilistTitle || item.animeKey || item.route || normalizeTitle(item.title)); }
function stableId(...parts) { return parts.filter(Boolean).join("-").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\p{L}\p{N}]+/gu,"-").replace(/(^-|-$)/g,""); }
function normalizeTitle(value) { return String(value||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/\([^)]*\)/g,"").replace(/\[[^\]]*\]/g,"").replace(/&/g,"and").replace(/\bseason\s*\d+\b/g,"").replace(/\bs\d+\b/g,"").replace(/\bpart\s*\d+\b/g,"").replace(/\bcour\s*\d+\b/g,"").replace(/\bthe\b/g,"").replace(/\ba\b/g,"").replace(/\ban\b/g,"").replace(/[^\p{L}\p{N}]+/gu,""); }
function normalizeUrl(url) { const v=String(url||"").trim(); if(!v)return ""; if(v.startsWith("http://")||v.startsWith("https://"))return v; if(v.startsWith("//"))return `https:${v}`; if(v.includes("."))return `https://${v}`; return ""; }
function getOpenLabel(service) { if(!service || service==="No legal platform" || service==="AniList")return "Asociar plataforma"; return `Ver en ${service}`; }
function getBestWatchUrl(item, displayService) {
  const custom = normalizeUrl(item.customUrl);
  if (custom) return custom;
  const effective = displayService !== undefined ? displayService : getDisplayService(item);
  if (effective === (item.service || "No legal platform")) {
    const serviceUrl = normalizeUrl(item.serviceUrl);
    if (serviceUrl) {
      if (effective === "Prime Video" && /amzn\.to|amazon\.(com|es|co\.uk|de|fr|it)/.test(serviceUrl))
        return `https://www.primevideo.com/search?phrase=${encodeURIComponent(item.title)}`;
      return serviceUrl;
    }
  }
  return defaultServiceUrl(effective);
}
function defaultServiceUrl(service) {
  const map = {
    "Crunchyroll": "https://www.crunchyroll.com/",
    "Netflix": "https://www.netflix.com/",
    "Prime Video": "https://www.primevideo.com/",
    "HIDIVE": "https://www.hidive.com/",
    "Disney+": "https://www.disneyplus.com/",
    "Hulu": "https://www.hulu.com/",
    "Apple TV+": "https://tv.apple.com/",
    "Max": "https://www.max.com/",
    "Funimation": "https://www.funimation.com/",
    "Paramount+": "https://www.paramountplus.com/",
    "Peacock": "https://www.peacocktv.com/",
    "Tubi": "https://tubitv.com/",
    "VRV": "https://vrv.co/",
    "Bilibili": "https://www.bilibili.tv/",
    "Muse Asia": "https://www.youtube.com/@MuseAsia",
    "Ani-One": "https://www.youtube.com/@AniOneAsia",
    "Wakanim": "https://www.wakanim.tv/",
    "Aniplus": "https://www.aniplus-asia.com/",
  };
  return map[service] || "";
}
function escapeHtml(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }

async function saveReleases() { await browserApi.storage.local.set({ releases: state.releases }); }
async function saveAllLists() { await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary }); }
function showStatus(message,type="") { els.statusBox.textContent=message; els.statusBox.className=`status-box ${type}`; setTimeout(()=>{ els.statusBox.className="status-box hidden"; },6000); }
function showFatal(error) { document.body.innerHTML=`<main style="padding:16px;font-family:Arial;background:#0f172a;color:white;min-height:650px"><h1>Error cargando extensión</h1><pre style="white-space:pre-wrap;color:#fecaca;background:#450a0a;border:1px solid #991b1b;border-radius:12px;padding:10px">${escapeHtml(error?.stack||error?.message||String(error))}</pre></main>`; }
function renderNextModern() {
  const items = getNextHighlightItems();
  if (!items.length) {
    state.currentNext = null;
    els.nextRelease.className = "next-release empty";
    if (state.viewMode === "today") {
      els.nextRelease.innerHTML = `<div class="next-content"><div class="next-label">¡Fin del día!</div><div class="next-title">Hoy no sale nada más</div><div class="next-episode">Revisa abajo los estrenos de hoy.</div></div>`;
      return;
    }
    els.nextRelease.innerHTML = `<div class="next-content"><div class="next-label">Sin estrenos</div><div class="next-title">No hay próximos episodios</div><div class="next-episode">${state.viewMode === "today" ? "No hay favoritos para hoy." : "Actualiza horarios en Ajustes."}</div></div>`;
    return;
  }

  const item = items[0];
  state.currentNext = item;
  const c = getCountdown(item.releaseDate);
  const scorePill = getAnilistScorePill(item);
  const premierePill = getPremierePill(item);
  const delayedPill = getDelayedPill(item);
  els.nextRelease.className = "next-release";
  els.nextRelease.innerHTML = `<div class="cover-stack next-cover-stack">${renderCover(item, "next-cover")}${scorePill}</div><div class="next-content"><div class="next-label">Próximo episodio</div><div class="next-title">${escapeHtml(item.title)}</div><div class="next-episode">${escapeHtml(item.episode)} · ${escapeHtml(getDisplayService(item))}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div><div class="next-countdown">${escapeHtml(c.text)}</div><div class="next-meta">${escapeHtml(formatDate(item.releaseDate))}${premierePill}${delayedPill}</div></div>`;
}

function getNextHighlightItems() {
  if (state.viewMode === "all") return getOneNextPerSeries(adjustDelayedDates(getCatalogItems()));
  if (state.viewMode === "today") return getRemainingTodayItems(adjustDelayedDates(getFavoriteItems()));
  return getOneNextPerSeries(adjustDelayedDates(getFavoriteItems()));
}

function renderListModern() {
  var visible = getVisibleItems();
  if (state.searchQuery) {
    var q = state.searchQuery.toLowerCase();
    visible = visible.filter(function(item) { return (item.title||"").toLowerCase().indexOf(q)>=0 || (item.episode||"").toLowerCase().indexOf(q)>=0 || (getDisplayService(item)||"").toLowerCase().indexOf(q)>=0; });
  }
  if (!state.sortAsc) visible = [].concat(visible).reverse();
  var title = state.viewMode==="today"?"Estrenos de hoy":state.viewMode==="favorites"?"Favoritos":"Proximos estrenos";
  var listTitle = document.getElementById("listTitle");
  if (listTitle) listTitle.textContent = title + " · " + visible.length;

  var frag = document.createDocumentFragment();
  if (!visible.length) {
    var empty = document.createElement("div");
    empty.className = "empty-message";
    empty.textContent = "No hay episodios para mostrar.";
    frag.appendChild(empty);
  } else {
    for (var i = 0; i < visible.length; i++) frag.appendChild(createCardModern(visible[i]));
  }
  els.animeList.innerHTML = "";
  els.animeList.appendChild(frag);
}

function createCardModern(item) {
  const c = getCountdown(item.releaseDate);
  const service = getDisplayService(item);
  const openLabel = item.customUrl ? `Ver en ${item.customPlatformName || "link asociado"}` : getOpenLabel(service);
  const delayedBadge = getDelayedBadge(item);
  const premiereBadge = getPremiereBadge(item);
  const scorePill = getAnilistScorePill(item);
  const customButton = item.customUrl
    ? `<button class="small-btn" type="button" data-action="removeCustomLink" data-key="${escapeHtml(getAnimeKey(item))}">Quitar link</button>`
    : `<button class="small-btn" type="button" data-action="customLink" data-key="${escapeHtml(getAnimeKey(item))}">Asociar link</button>`;
  const card = document.createElement("article");
  card.className = "anime-card";
  card.dataset.id = item.id;
  card.dataset.action = "open";
  const badgeLabel = service === "No legal platform" ? (item.customPlatformName || "Sin plataforma") : service;
  card.innerHTML = `<div class="cover-stack">${renderCover(item, "cover")}${scorePill}</div><div class="card-main"><div class="card-top"><div class="card-heading"><div class="anime-title">${escapeHtml(item.title)}</div><div class="anime-episode">${escapeHtml(item.episode)} · ${escapeHtml(service)}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div></div><button class="favorite-btn ${item.favorite ? 'favorite' : 'add'}" type="button" aria-label="${item.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}" data-action="favorite" data-key="${escapeHtml(getAnimeKey(item))}">${item.favorite ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>` : "+"}</button></div><div class="countdown">${escapeHtml(c.text)}</div><div class="meta">${escapeHtml(formatDate(item.releaseDate))}</div><div class="badges"><span class="badge badge-purple">${escapeHtml(badgeLabel)}</span>${premiereBadge}${delayedBadge}</div><div class="card-actions"><button class="small-btn primary-link" type="button" data-action="open" data-id="${escapeHtml(item.id)}">${escapeHtml(openLabel)}</button>${customButton}</div></div>`;
  return card;
}

function getPremiereBadge(item) {
  return isPremiereEpisode(item) ? '<span class="badge badge-premiere">Nuevo estreno</span>' : "";
}

function getPremierePill(item) {
  return isPremiereEpisode(item) ? '<span class="today-pill premiere-pill">Nuevo estreno</span>' : "";
}

function getDelayedBadge(item) {
  return item.delayed ? '<span class="badge badge-orange">Retrasado</span>' : "";
}

function getDelayedPill(item) {
  return item.delayed ? '<span class="today-pill delayed-pill">Retrasado</span>' : "";
}

function isPremiereEpisode(item) {
  const episode = parseEpisodeNumber(item.episodeNumber ?? item.episode);
  if (Number.isFinite(episode) && episode <= 1) return true;
  return !Number.isFinite(episode) && /(?:^|\b)(?:ep(?:isodio)?\.?\s*)?1(?:\b|$)/i.test(String(item.episode || ""));
}

function getAnilistScorePill(item) {
  if (!state.showAnilistScore) return "";
  const score = formatAnilistScore(item.anilistScore);
  return score ? `<span class="score-pill" title="Nota de AniList"><span class="score-value">${escapeHtml(score)}</span><span class="score-source">AniList</span></span>` : "";
}

function formatAnilistScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) return "";
  const normalized = value > 10 ? value / 10 : value;
  return normalized.toFixed(1).replace(/\.0$/, "");
}
