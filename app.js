"use strict";

const LARGE_STORAGE_KEYS = new Set(["releases", "anilistLibrary", "anilistMap", "customLinks", "customPlatforms", "userOverrides"]);
const IDB_NAME = "animeCountdownDb";
const IDB_STORE = "state";
const IDB_VERSION = 1;
let idbPromise = null;
let memorySmallStorage = "{}";
let smallStorageInMemory = false;
let storageWriteQueue = Promise.resolve();
function readSmallStorage() {
  if (smallStorageInMemory) return memorySmallStorage;
  try { return localStorage.getItem("animeCountdownStorage") || memorySmallStorage; }
  catch { return memorySmallStorage; }
}

// Browser/PWA compatibility layer.
// The original extension uses chrome.storage.local and chrome.tabs.
// In the PWA these are mapped to IndexedDB/localStorage and window.open.
const browserApi = {
  storage: {
    local: {
      async get(keys) {
        await storageWriteQueue;
        const raw = readSmallStorage();
        const store = parseStoredState(raw);
        const large = await getLargeStorageValues(keys);
        for (const [key, value] of Object.entries(large)) {
          if (!(Array.isArray(store.__largeFallbackKeys) ? store.__largeFallbackKeys : []).includes(key)) store[key] = value;
        }

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

      set(values) {
        const operation = storageWriteQueue.then(() => persistStorageValues(values));
        storageWriteQueue = operation.catch(() => {});
        return operation;
      }
    }
  },

  tabs: {
    create({ url }) {
      openExternalUrl(url);
    }
  }
};

async function persistStorageValues(values) {
  const raw = readSmallStorage();
  const store = parseStoredState(raw);
  platformPolicy.migrateLocalPreferences(store);
  platformPolicy.migrateLocalPreferences(values);
  const smallValues = {};
  const largeValues = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (LARGE_STORAGE_KEYS.has(key)) largeValues[key] = value;
    else smallValues[key] = value;
  }
  if (Object.keys(largeValues).length) invalidateDataCaches();
  const wroteLargeValues = await setLargeStorageValues(largeValues);
  Object.assign(store, smallValues);
  const fallbackKeys = new Set(Array.isArray(store.__largeFallbackKeys) ? store.__largeFallbackKeys : []);
  for (const key of Object.keys(largeValues)) {
    if (wroteLargeValues) fallbackKeys.delete(key); else fallbackKeys.add(key);
    if (wroteLargeValues) delete store[key];
    else store[key] = largeValues[key];
  }
  store.__largeFallbackKeys = [...fallbackKeys];
  memorySmallStorage = JSON.stringify(store);
  try { localStorage.setItem("animeCountdownStorage", memorySmallStorage); smallStorageInMemory = false; }
  catch { smallStorageInMemory = true; memorySmallStorage = JSON.stringify(store); showStatus("No se pudieron guardar algunos ajustes en este dispositivo.", "warn"); }
}

function openStateDb() {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  if (idbPromise) return idbPromise;
  const promise = new Promise(resolve => {
    let request;
    let settled = false;
    const finish = db => {
      if (settled) { db?.close(); return; }
      settled = true;
      clearTimeout(timeout);
      if (db) db.onversionchange = () => { db.close(); idbPromise = null; };
      resolve(db);
    };
    const timeout = setTimeout(() => finish(null), 3000);
    try { request = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch { finish(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => finish(request.result);
    request.onblocked = request.onerror = () => finish(null);
  });
  idbPromise = promise;
  promise.then(db => { if (!db && idbPromise === promise) idbPromise = null; });
  return promise;
}

function getRequestedLargeKeys(keys) {
  if (Array.isArray(keys)) return keys.filter((key) => LARGE_STORAGE_KEYS.has(key));
  if (typeof keys === "string") return LARGE_STORAGE_KEYS.has(keys) ? [keys] : [];
  if (keys && typeof keys === "object") return Object.keys(keys).filter((key) => LARGE_STORAGE_KEYS.has(key));
  return [...LARGE_STORAGE_KEYS];
}

async function getLargeStorageValues(keys) {
  const requested = getRequestedLargeKeys(keys);
  if (!requested.length) return {};
  const db = await openStateDb().catch(() => null);
  if (!db) return {};

  return new Promise((resolve) => {
    const result = {};
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    for (const key of requested) {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined) result[key] = request.result;
      };
    }
    const timeout = setTimeout(() => { try { tx.abort(); } catch {} resolve({}); }, 3000);
    tx.oncomplete = () => { clearTimeout(timeout); resolve(result); };
    tx.onerror = tx.onabort = () => { clearTimeout(timeout); resolve({}); };
  }).catch(() => ({}));
}

async function setLargeStorageValues(values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return true;
  const db = await openStateDb().catch(() => null);
  if (!db) return false;

  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const [key, value] of entries) store.put(value, key);
    const timeout = setTimeout(() => { try { tx.abort(); } catch {} resolve(false); }, 3000);
    tx.oncomplete = () => { clearTimeout(timeout); resolve(true); };
    tx.onerror = tx.onabort = () => { clearTimeout(timeout); resolve(false); };
  }).catch(() => false);
}

function openExternalUrl(url) {
  if (isCapacitor() && url) {
    window.open(url, "_system");
    return;
  }
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
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn("Datos locales corruptos; se reinicia el almacenamiento de la app.", error);
    try { localStorage.removeItem("animeCountdownStorage"); } catch {}
    return {};
  }
}




const API_BASE = "https://animeschedule.net/api/v3";
const IMAGE_BASE = "https://img.animeschedule.net/production/assets/public/img/";
const APP_CONFIG = window.ANIME_COUNTDOWN_CONFIG || {};
const SHARED_SCHEDULE_URL = String(isCapacitor() ? (APP_CONFIG.REMOTE_SCHEDULE_URL || "https://anicountdown.com/schedule.json") : (APP_CONFIG.SHARED_SCHEDULE_URL || "./schedule.json"));
const policy = window.SchedulePolicy;
const platformPolicy = window.PlatformPolicy;
const nativeFetch = window.fetch.bind(window);
function requestTimeoutSignal() {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(20000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20000);
  return controller.signal;
}
const fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal || requestTimeoutSignal() });
let sharedRefreshPromise = null;
const PUBLIC_SCHEDULE_DAYS = Number(APP_CONFIG.PUBLIC_SCHEDULE_DAYS || 90);
const ANILIST_AIRING_MAX_PAGES = Number(APP_CONFIG.ANILIST_AIRING_MAX_PAGES || APP_CONFIG.ANILIST_CATALOG_MAX_PAGES || 20);
const RECENT_RELEASE_DAYS = Number(APP_CONFIG.RECENT_RELEASE_DAYS || 7);
const DEFAULT_IMPORT_WEEKS = 4;
const NOTIFICATION_LEAD_MS = 0;
const NOTIFICATION_GRACE_MS = 30 * 60 * 1000;
const VISIBLE_NOTIFICATION_CHECK_MS = 15 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const NATIVE_NOTIFICATION_SYNC_MS = 6 * 60 * 60 * 1000;
const ANILIST_REFRESH_MS = 24 * 60 * 60 * 1000;
const ANILIST_MANUAL_COOLDOWN_MS = 1 * 60 * 1000;
const PUBLIC_ANILIST_REFRESH_MS = 24 * 60 * 60 * 1000;
const SHARED_SCHEDULE_REFRESH_MS = 15 * 60 * 1000;
const VIRTUAL_LIST_BATCH_SIZE = 24;
// Solo estas variantes representan las suscripciones de la app; los demás canales se ignoran.
const SUBSCRIPTIONS = {
  "Crunchyroll": ["Crunchyroll", "Crunchyroll Amazon Channel"],
  "Prime Video": ["Prime Video", "Amazon Prime Video with Ads"],
  "Disney+": ["Disney+"],
  "Netflix": ["Netflix"]
};
const SERVICE_PRIORITY = Object.fromEntries(Object.keys(SUBSCRIPTIONS).map((name, index) => [name, index + 1]));
function subscriptionService(service) {
  return Object.keys(SUBSCRIPTIONS).find(name => SUBSCRIPTIONS[name].includes(service)) || "";
}
function serviceLabel(service) { return service === "No legal platform" ? "Sin plataforma" : service; }
const CONTENT_FILTERS = [
  { key: "adult", label: "Adulto / hentai", defaultHidden: true },
  { key: "kodomo", label: "Kodomo", defaultHidden: true },
  { key: "ova", label: "OVA", defaultHidden: true },
  { key: "ona", label: "ONA", defaultHidden: false },
  { key: "movie", label: "Películas", defaultHidden: true },
  { key: "special", label: "Especiales", defaultHidden: true },
  { key: "music", label: "Music", defaultHidden: true }
];
const DEFAULT_HIDDEN_CONTENT = CONTENT_FILTERS.filter((item) => item.defaultHidden).map((item) => item.key);

const $ = (id) => document.getElementById(id);
const state = { releases: [], anilistLibrary: [], anilistMap: {}, customLinks: {}, personalSearchTemplate: "", personalLinkName: "", customPlatforms: {}, userOverrides: {}, viewMode: "today", currentNext: null, timezone: "Europe/Madrid", jwCountry: "ES", hiddenPlatforms: [], hiddenContent: DEFAULT_HIDDEN_CONTENT.slice(), notificationEnabled: false, showAnilistScore: true, notifiedReleaseIds: {}, scheduleHealth: { loading: true }, lastSharedSync: "", lastAnilistSync: "", lastAnilistSyncUsername: "", lastPublicAnilistSync: "", lastPlatformSync: "", lastNativeNotificationSync: "", searchQuery: "", sortAsc: true };
const els = {};
const autoSaveTimers = {};
let quarterNotificationTimer = null;
let swipeStart = null;
var preRendered = {};
let renderGeneration = 0;
let renderRemainingTimer = null;
let midnightRefreshTimer = null;
let dataVersion = 0;
const listMemo = new Map();
let virtualListItems = [];
let virtualListRendered = 0;
let virtualListObserver = null;
let nativeNotificationSyncForce = false;
let nativeNotificationSyncTimer = null;
let nativeNotificationSyncRunning = false;
let nativeNotificationSyncPending = false;
const NATIVE_NOTIFICATION_VERSION = 1;
const NATIVE_NOTIFICATION_WINDOW_MS = 14 * 24 * 3600 * 1000;
const NATIVE_NOTIFICATION_CHANNEL = "anime-releases";

init();

async function init() {
  try {
    bindElements();
    await loadState();
    bindEvents();
    registerServiceWorker();
    updateNotificationButton();
    render();
    setInterval(updateLiveCountdowns, 1000);
    scheduleMidnightRefresh();
    startNotificationScheduler();
    startBackgroundRefreshes();
    setupCapacitorNotificationTap();
    setupAndroidBackButton();
  } catch (error) {
    showFatal(error);
  }
}

function startBackgroundRefreshes() {
  // Always validate persisted releases on startup. A recently stored schedule
  // can still be obsolete after a server-side correction or deployment.
  refreshSharedSchedule({ silent: true, force: true, skipPublicAnilist: true }).catch((error) =>
    console.warn("No se pudo validar el horario al iniciar.", error)
  );
  setInterval(() => {
    if (document.visibilityState === "visible") {
      refreshSharedSchedule({ silent: true, skipPublicAnilist: true }).catch(() => {});
    }
  }, SHARED_SCHEDULE_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const timezone = getDeviceTimezone();
      if (state.timezone !== timezone) {
        state.timezone = timezone;
        scheduleMidnightRefresh();
      }
      invalidateDataCaches();
      render();
      scheduleBackgroundTask(() => refreshSharedSchedule({ silent: true, skipPublicAnilist: true }), 100);
    }
  });
  startAnilistAutoRefresh();
  // The shared schedule is already enriched by AniList on the server. Avoid
  // downloading the full public catalog on every phone after startup.
  if (!isSharedScheduleConfigured()) startPublicAnilistAutoRefresh();
}

function scheduleBackgroundTask(fn, timeout = 1000) {
  const run = () => Promise.resolve().then(fn).catch((error) => console.warn("Tarea en segundo plano fallida.", error));
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(run, { timeout });
    return;
  }
  setTimeout(run, timeout);
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    if ("requestAnimationFrame" in window) requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

function invalidateDataCaches() {
  dataVersion++;
  listMemo.clear();
  preRendered = {};
}

function memoList(key, factory) {
  const fullKey = `${dataVersion}|${key}`;
  if (listMemo.has(fullKey)) return listMemo.get(fullKey);
  const value = factory();
  if (Array.isArray(value)) {
    try { Object.defineProperty(value, "__memoKey", { value: fullKey, enumerable: false }); } catch (_) {}
  }
  listMemo.set(fullKey, value);
  return value;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isCapacitor()) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function bindElements() {
  ["settingsBtn","closeSettingsBtn","settingsPanel","statusBox","nextRelease","animeList","showAllBtn","showTodayBtn","showFavsBtn","notificationBtn","anilistInput","syncAnilistBtn","resetBtn","themeBtn","scoreBtn","contentFilterContainer"].forEach((id) => els[id] = $(id));
  const missing = ["settingsBtn","settingsPanel","nextRelease","animeList"].filter((id) => !els[id]);
  if (missing.length) throw new Error("Faltan elementos HTML: " + missing.join(", "));
}

async function loadState() {
  const data = await browserApi.storage.local.get(["releases","anilistLibrary","anilistMap","customLinks","customPlatforms","userOverrides","viewMode","animeScheduleToken","jwCountry","hiddenPlatforms","personalSearchTemplate","personalLinkName","hiddenContent","contentFiltersVersion","anilistUsername","notificationEnabled","showAnilistScore","notifiedReleaseIds","lastSharedSync","lastAnilistSync","lastAnilistSyncUsername","lastPublicAnilistSync","lastPlatformSync","lastNativeNotificationSync","nativeNotificationVersion","nativeNotificationsUntil","theme","scheduleMetadata"]);
  const preferencesMigrated = platformPolicy.migrateLocalPreferences(data);
  if (preferencesMigrated) await browserApi.storage.local.set({ userOverrides: data.userOverrides });
  state.releases = (Array.isArray(data.releases) ? data.releases : [])
    .filter(item => item && typeof item === "object" && typeof item.title === "string")
    .map(sanitizePlatformFields)
    .filter((item) => !isAniListTimedRelease(item) && !item.inferredFromAnimeSchedule && !item.inferred_from_animeschedule);
  state.anilistLibrary = (Array.isArray(data.anilistLibrary) ? data.anilistLibrary : []).filter(item => item && typeof item === "object" && typeof item.title === "string").map(sanitizePlatformFields).map(stripAnilistOnlyTiming);
  state.anilistMap = data.anilistMap && typeof data.anilistMap === "object" && !Array.isArray(data.anilistMap) ? data.anilistMap : {};
  state.customLinks = data.customLinks && typeof data.customLinks === "object" && !Array.isArray(data.customLinks) ? data.customLinks : {};
  state.customPlatforms = data.customPlatforms && typeof data.customPlatforms === "object" && !Array.isArray(data.customPlatforms) ? data.customPlatforms : {};
  state.userOverrides = data.userOverrides && typeof data.userOverrides === "object" && !Array.isArray(data.userOverrides) ? data.userOverrides : {};
  sanitizeCustomPlatformStorage();
  migrateLegacyUserOverrides();
  applyCustomToReleases();
  applyUserOverridesToLists();
  state.viewMode = data.viewMode || "today";
  state.timezone = getDeviceTimezone();
  state.jwCountry = "ES";
  if (data.jwCountry !== "ES") await browserApi.storage.local.set({ jwCountry: "ES" });
  state.releases = state.releases.map(item => sanitizePlatformFields(platformPolicy.applyCountryPlatforms(item, state.jwCountry)));
  state.hiddenPlatforms = [...new Set((Array.isArray(data.hiddenPlatforms) ? data.hiddenPlatforms : []).filter(name => Object.hasOwn(SUBSCRIPTIONS, name)))];
  await browserApi.storage.local.set({ hiddenPlatforms: state.hiddenPlatforms });
  state.personalSearchTemplate = validatePersonalSearchTemplate(data.personalSearchTemplate);
  $("personalSearchInput").value = typeof data.personalSearchTemplate === "string" ? data.personalSearchTemplate : "";
  renderPersonalSearchValidation();
  state.personalLinkName = cleanPersonalLinkName(data.personalLinkName);
  $("personalLinkNameInput").value = state.personalLinkName;
  state.hiddenContent = Array.isArray(data.hiddenContent) ? data.hiddenContent : DEFAULT_HIDDEN_CONTENT.slice();
  if (data.contentFiltersVersion !== 1) {
    state.hiddenContent = state.hiddenContent.filter(key => key !== "ona");
    await browserApi.storage.local.set({ hiddenContent: state.hiddenContent, contentFiltersVersion: 1 });
  }
  state.notificationEnabled = Boolean(data.notificationEnabled);
  if (preferencesMigrated) queueNativeNotificationSync({ force: true });
  state.showAnilistScore = data.showAnilistScore !== false;
  state.notifiedReleaseIds = data.notifiedReleaseIds && typeof data.notifiedReleaseIds === "object" && !Array.isArray(data.notifiedReleaseIds) ? data.notifiedReleaseIds : {};
  state.lastSharedSync = data.lastSharedSync || "";
  state.scheduleHealth = { ...policy.health({ releases: state.releases, ...data.scheduleMetadata }), platforms: data.scheduleMetadata?.platforms || null, loading: true };
  state.lastAnilistSync = data.lastAnilistSync || "";
  state.lastAnilistSyncUsername = data.lastAnilistSyncUsername || "";
  state.lastPublicAnilistSync = data.lastPublicAnilistSync || "";
  state.lastPlatformSync = data.lastPlatformSync || "";
  state.lastNativeNotificationSync = data.lastNativeNotificationSync || "";
  state.nativeNotificationVersion = data.nativeNotificationVersion || 0;
  state.nativeNotificationsUntil = data.nativeNotificationsUntil || "";
  state.theme = data.theme || "dark";
  if (els.tokenInput) els.tokenInput.value = data.animeScheduleToken || "";
  els.anilistInput.value = data.anilistUsername || "";
  applyTheme(state.theme);
  updateScoreButton();
  invalidateDataCaches();
  scheduleBackgroundTask(saveSanitizedState, 1800);
}

function bindEvents() {
  bindLinkDialog();
  bindCardGestures();
  $("retryScheduleBtn")?.addEventListener("click", () => refreshSharedSchedule({ force: true, silent: false, skipPublicAnilist: true }));
  els.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(els.settingsPanel.classList.contains("hidden"));
  });
  els.closeSettingsBtn.addEventListener("click", () => setSettingsOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("linkDialog").open) { e.preventDefault(); closeLinkDialog(); }
    else if (e.key === "Escape" && !els.settingsPanel.classList.contains("hidden")) setSettingsOpen(false);
  });
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
  $("personalLinkNameInput").addEventListener("input", savePersonalLinkName);
  $("personalSearchInput").addEventListener("input", savePersonalSearchTemplate);
  els.tokenInput?.addEventListener("input", () => debounceAutoSave("token", saveToken));
  document.getElementById("platformFilterContainer")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.target.closest(".platform-chip");
    if (chip) togglePlatformFilter(chip.dataset.platform);
  });
  els.contentFilterContainer?.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.target.closest(".platform-chip");
    if (chip) toggleContentFilter(chip.dataset.filter);
  });
  els.notificationBtn?.addEventListener("click", toggleNotifications);
  els.anilistInput.addEventListener("input", () => debounceAutoSave("anilist", saveAnilistUsername));
  els.syncAnilistBtn.addEventListener("click", syncAnilist);
  els.importBtn?.addEventListener("click", importSchedule);
  els.openAnimeScheduleBtn?.addEventListener("click", () => browserApi.tabs.create({ url: "https://animeschedule.net/" }));
  els.resetBtn.addEventListener("click", resetAll);
  els.themeBtn.addEventListener("click", toggleTheme);
  els.scoreBtn?.addEventListener("click", toggleAnilistScore);
  const searchInput = document.getElementById("searchInput");
  const sortBtn = document.getElementById("sortBtn");
  if (searchInput) searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value.trim();
    $("clearSearchBtn").hidden = !state.searchQuery;
    render();
  });
  $("clearSearchBtn")?.addEventListener("click", () => {
    searchInput.value = "";
    state.searchQuery = "";
    $("clearSearchBtn").hidden = true;
    render();
    searchInput.focus();
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

}

async function setupAndroidBackButton() {
  if (!isCapacitor() || Capacitor.getPlatform?.() !== "android") return;
  const app = Capacitor.Plugins?.App;
  if (!app) return;
  try {
    // App 6 disables its default back handling when this listener is registered.
    await app.addListener("backButton", ({ canGoBack }) => {
      if ($("linkDialog").open) closeLinkDialog();
      else if (!els.settingsPanel.classList.contains("hidden")) setSettingsOpen(false);
      else if (canGoBack) window.history.back();
      else app.exitApp();
    });
  } catch (error) {
    console.warn("No se pudo registrar el botón Atrás.", error);
  }
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  document.body.classList.toggle("settings-open", open);
  els.settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderAnilistSyncStatus();
  (open ? els.closeSettingsBtn : els.settingsBtn).focus({ preventScroll: true });
}

async function setMode(mode, direction) {
  state.viewMode = mode;
  browserApi.storage.local.set({ viewMode: mode });
  render();
}

function bindSwipeNavigation() {
  var list = els.animeList;
  var preview = document.getElementById("swipePreview");
  if (!list) return;

  var THRESHOLD = 80;
  var swiping = false;
  var swipeStartX = 0;
  var swipePx = 0;
  var lastMode = null;

  var modes = ["all", "today", "favorites"];
  var tabs = [els.showAllBtn, els.showTodayBtn, els.showFavsBtn];
  var indicator = document.querySelector(".tab-indicator");

  function edge(dir) {
    var idx = modes.indexOf(state.viewMode);
    return (dir < 0 && idx <= 0) || (dir > 0 && idx >= modes.length - 1);
  }

  function renderPreview(mode) {
    if (!preview) return;
    var prev = state.viewMode;
    state.viewMode = mode;
    var items = getVisibleItems();
    state.viewMode = prev;
    preview.innerHTML = "";
    var take = Math.min(items.length, 4);
    for (var i = 0; i < take; i++) {
      preview.appendChild(createCardModern(items[i]));
    }
  }

  function shift(px) {
    var dir = px < 0 ? 1 : -1;
    if (edge(dir)) {
      list.style.transition = "none";
      list.style.transform = "translateX(" + (px * 0.22) + "px)";
      list.style.opacity = "1";
      if (preview) { preview.style.opacity = "0"; preview.style.transform = ""; }
      return;
    }

    list.style.transition = "none";
    list.style.transform = "translateX(" + px + "px)";
    list.style.opacity = 1 - Math.abs(px) / 300;

    var p = Math.min(Math.abs(px) / THRESHOLD, 1);
    var idx = modes.indexOf(state.viewMode);
    var tgt = Math.max(0, Math.min(modes.length - 1, idx + dir));
    if (idx === tgt) return;

    var targetMode = modes[tgt];
    if (targetMode !== lastMode && p > 0.3) {
      lastMode = targetMode;
      renderPreview(targetMode);
    }

    if (preview) {
      preview.style.transition = "none";
      var gap = 10;
      preview.style.transform = "translateX(" + (px + dir * (list.offsetWidth + gap)) + "px)";
      preview.style.opacity = p > 0.35 ? String(Math.min((p - 0.35) * 1.5, 0.75)) : "0";
    }

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
    if (preview) { preview.style.transition = "opacity 180ms var(--ease), transform 180ms var(--ease)"; preview.style.opacity = "0"; preview.style.transform = ""; }
    if (indicator) indicator.style.transition = "transform 280ms var(--ease)";
    finish();
  }

  function finish() {
    swiping = false;
    swipeStartX = 0;
    swipePx = 0;
    swipeStart = null;
    lastMode = null;
    if (preview) { preview.innerHTML = ""; preview.style.transform = ""; preview.style.opacity = "0"; }
    tabs.forEach(function(t) { t.style.opacity = ""; t.style.color = ""; });
    setActiveTab();
  }

  function commit() {
    var dir = swipePx < 0 ? 1 : -1;
    if (edge(dir)) { back(); return; }
    swiping = false;
    swipeStart = null;

    var w = list.offsetWidth;
    var outPx = -dir * (w + 30);

    list.style.transition = "transform 360ms var(--ease)";
    list.style.transform = "translateX(" + outPx + "px)";

    if (preview) {
      preview.style.transition = "transform 360ms var(--ease)";
      preview.style.transform = "translateX(0px)";
      preview.style.opacity = "1";
    }

    setTimeout(function() {
      list.style.transition = "none";
      list.style.transform = "";
      list.style.opacity = "1";
      if (preview) { preview.style.transition = "none"; preview.style.opacity = "0"; preview.style.transform = ""; }
      goToAdjacentMode(dir);
      finish();
    }, 370);
  }

  list.addEventListener("touchmove", function(e) {
    if ($("linkDialog").open || e.touches.length !== 1) return;
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
  if (renderRemainingTimer) {
    clearTimeout(renderRemainingTimer);
    renderRemainingTimer = null;
  }
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
async function saveAnilistUsername() { await browserApi.storage.local.set({ anilistUsername: els.anilistInput.value.trim() }); }

function cleanPersonalLinkName(value) { return typeof value === "string" ? value.trim().slice(0, 30) : ""; }
async function savePersonalLinkName() {
  state.personalLinkName = cleanPersonalLinkName($("personalLinkNameInput").value);
  await browserApi.storage.local.set({ personalLinkName: state.personalLinkName });
  render();
}
function validatePersonalSearchTemplate(value) {
  if (typeof value !== "string" || !/{titulo}|{slug}/.test(value.trim())) return "";
  const template = value.trim();
  try {
    const url = new URL(template.replaceAll("{titulo}", "prueba").replaceAll("{slug}", "prueba"));
    return url.protocol === "https:" && !url.username && !url.password ? template : "";
  } catch { return ""; }
}
function renderPersonalSearchValidation() {
  const input = $("personalSearchInput");
  const invalid = Boolean(input.value.trim() && !validatePersonalSearchTemplate(input.value));
  input.setAttribute("aria-invalid", String(invalid));
  $("personalSearchWarning").hidden = !invalid;
}
async function savePersonalSearchTemplate() {
  const value = $("personalSearchInput").value.trim();
  state.personalSearchTemplate = validatePersonalSearchTemplate(value);
  renderPersonalSearchValidation();
  await browserApi.storage.local.set({ personalSearchTemplate: state.personalSearchTemplate });
  queueNativeNotificationSync({ force: true });
  render();
}
function getPersonalSearchUrl(item) {
  const template = validatePersonalSearchTemplate(state.personalSearchTemplate);
  const title = String(item.title || "");
  if (!template || !title.trim()) return "";
  // The first alias is the romaji title (AnimeSchedule and AniList rows both put it first); item.title can be English.
  const romaji = (Array.isArray(item.titles) && typeof item.titles[0] === "string" && item.titles[0].trim()) || title;
  const slug = romaji.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (template.includes("{slug}") && !slug) return "";
  return template.replaceAll("{titulo}", encodeURIComponent(title)).replaceAll("{slug}", slug);
}
function getDetectedPlatforms() { return Object.keys(SUBSCRIPTIONS); }

function renderAnilistSyncStatus() {
  const status = $("anilistSyncStatus");
  if (status) status.textContent = state.lastAnilistSync
    ? `Última sincronización: ${formatDate(state.lastAnilistSync)}`
    : "Aún no has sincronizado";
}

function renderSettingsChip(label, active, attribute, value) {
  const check = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  return `<button class="platform-chip${active ? " active" : ""}" ${attribute}="${escapeHtml(value)}" aria-pressed="${active}" type="button">${active ? check : ""}${escapeHtml(label)}</button>`;
}

function renderSettingsPlatformFilter() {
  const container = document.getElementById("platformFilterContainer");
  if (!container) return;
  const platforms = getDetectedPlatforms();
  container.innerHTML = platforms.map((p) => {
    const hidden = state.hiddenPlatforms.includes(p);
    return renderSettingsChip(p, !hidden, "data-platform", p);
  }).join("");
  const count = $("platformFilterCount");
  if (count) count.textContent = `${platforms.filter(p => !state.hiddenPlatforms.includes(p)).length} de ${platforms.length}`;
}

function renderContentFilter() {
  const container = els.contentFilterContainer || document.getElementById("contentFilterContainer");
  if (!container) return;
  container.innerHTML = CONTENT_FILTERS.map((filter) => {
    const visible = !state.hiddenContent.includes(filter.key);
    return renderSettingsChip(filter.label, visible, "data-filter", filter.key);
  }).join("");
  const count = $("contentFilterCount");
  if (count) count.textContent = `${CONTENT_FILTERS.filter(f => !state.hiddenContent.includes(f.key)).length} de ${CONTENT_FILTERS.length}`;
}

async function toggleContentFilter(filterKey) {
  if (!CONTENT_FILTERS.some((filter) => filter.key === filterKey)) return;
  const idx = state.hiddenContent.indexOf(filterKey);
  if (idx >= 0) state.hiddenContent.splice(idx, 1);
  else state.hiddenContent.push(filterKey);
  invalidateDataCaches();
  await browserApi.storage.local.set({ hiddenContent: state.hiddenContent });
  render();
}

async function togglePlatformFilter(platform) {
  if (!Object.hasOwn(SUBSCRIPTIONS, platform)) return;
  const idx = state.hiddenPlatforms.indexOf(platform);
  if (idx >= 0) {
    state.hiddenPlatforms.splice(idx, 1);
  } else {
    state.hiddenPlatforms.push(platform);
  }
  invalidateDataCaches();
  await browserApi.storage.local.set({ hiddenPlatforms: state.hiddenPlatforms });
  queueNativeNotificationSync({ force: true });
  render();
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

    await createNativeNotificationChannel(LocalNotifications);
    const notifId = hashNotificationId(testItem);
    const coverPath = await downloadCoverImage(testItem.coverUrl, notifId);
    await LocalNotifications.schedule({
      notifications: [{
        id: notifId,
        title: "Anime de Prueba Ep 1",
        body: getDisplayService(testItem) === "No legal platform" ? "Ya disponible." : `Ya disponible en ${getDisplayService(testItem)}.`,
        schedule: { at: new Date(releaseAt), allowWhileIdle: true },
        channelId: NATIVE_NOTIFICATION_CHANNEL,
        extra: { url: getBestWatchUrl(testItem) || location.href },
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
  var templates = state.releases
    .filter(function (item) { return item.coverUrl && item.title && item.source !== "test-data"; })
    .slice(0, 50);
  if (!templates.length) {
    return showStatus("No hay datos reales. Refresca los horarios primero.", "warn");
  }

  var template = templates[Math.floor(Math.random() * templates.length)];
  var seriesKey = getSeriesKey(template);
  var existingEps = state.releases
    .filter(function (r) { return getSeriesKey(r) === seriesKey; })
    .map(function (r) { return parseInt(r.episodeNumber); })
    .filter(function (n) { return Number.isFinite(n); });
  var maxEp = existingEps.length ? Math.max.apply(null, existingEps) : 0;
  var nextEp = maxEp + 1;
  var releaseAt = Date.now() + 30 * 1000;
  var releaseDate = new Date(releaseAt).toISOString();

  var testItem = sanitizePlatformFields({
    id: stableId("test", template.title, nextEp, releaseDate),
    animeKey: template.animeKey || getAnimeKey(template),
    title: template.title,
    route: template.route || "",
    episode: "Ep " + nextEp,
    episodeNumber: String(nextEp),
    airType: "SUB",
    delayed: false,
    releaseDate: releaseDate,
    originalReleaseDate: "",
    service: template.service || "Crunchyroll",
    serviceUrl: template.serviceUrl || "",
    allServices: template.allServices || [],
    hasAllowedPlatform: template.hasAllowedPlatform || false,
    source: "test-data",
    favorite: true,
    coverUrl: template.coverUrl || "",
    anilistId: template.anilistId || 0,
    anilistTitle: template.anilistTitle || template.title || "",
    customUrl: "",
    customPlatformName: ""
  });

  state.releases.push(testItem);
  state.releases = sortByDate(state.releases);
  await saveAllLists();
  render();

  if (isCapacitor()) {
    var LocalNotifications = getLocalNotifications();
    if (!LocalNotifications) return showStatus("Anime añadido pero sin plugin de notificaciones.", "warn");

    try {
      var permResult = await LocalNotifications.checkPermissions();
      if (permResult.display !== "granted") {
        var reqResult = await LocalNotifications.requestPermissions();
        if (reqResult.display !== "granted") {
          return showStatus("Anime añadido pero sin permiso de notificaciones.", "warn");
        }
      }

      await createNativeNotificationChannel(LocalNotifications);
      var notifId = hashNotificationId(testItem);
      var coverPath = await downloadCoverImage(testItem.coverUrl, notifId);
      var bodyText = getDisplayService(testItem) !== "No legal platform"
        ? "Ya disponible en " + getDisplayService(testItem) + "."
        : "Ya disponible.";

      await LocalNotifications.schedule({
        notifications: [{
          id: notifId,
          title: testItem.title + " " + testItem.episode,
          body: bodyText,
          largeBody: bodyText,
          summaryText: bodyText,
          schedule: { at: new Date(releaseAt), allowWhileIdle: true },
          channelId: NATIVE_NOTIFICATION_CHANNEL,
          extra: { url: getBestWatchUrl(testItem) || location.href, title: testItem.title },
          smallIcon: "ic_stat_icon",
          largeIcon: coverPath || undefined,
          iconColor: "#111827",
          actionTypeId: "",
          attachments: coverPath ? [{ id: "cover", url: coverPath }] : null,
          group: "anime-countdown"
        }]
      });

      showStatus(testItem.title + " " + testItem.episode + " se estrena en 30s. Cierra la app.", "success");
    } catch (error) {
      console.error("Error al programar notificacion:", error);
      showStatus("Error: " + (error.message || "desconocido"), "error");
    }
  } else {
    showStatus(testItem.title + " " + testItem.episode + " añadido. Se estrena en 30s.", "success");
    if ("Notification" in window && Notification.permission === "granted" && "serviceWorker" in navigator) {
      var reg = await navigator.serviceWorker.ready;
      var cov = normalizeUrl(testItem.coverUrl);
      var u = getBestWatchUrl(testItem) || location.href;
      reg.showNotification(testItem.title + " " + testItem.episode, {
        body: getDisplayService(testItem) !== "No legal platform" ? "Ya disponible en " + getDisplayService(testItem) + "." : "Ya disponible.",
        icon: cov || "./icons/icon-192.png",
        image: cov || undefined,
        badge: "./icons/notification-badge.svg",
        tag: "anime-" + testItem.id,
        renotify: true,
        requireInteraction: true,
        timestamp: releaseAt,
        data: { url: u }
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

  const active = state.notificationEnabled && (hasNativeNotif ? state.nativeDisplayPermission !== "denied" : Notification.permission === "granted");
  if (!active) {
    let granted = false;
    if (!hasNativeNotif && hasWebNotif && Notification.permission !== "granted") {
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
    if (!hasNativeNotif) granted = Notification.permission === "granted";
    if (hasNativeNotif) {
      try {
        const LocalNotifications = getLocalNotifications();
        if (LocalNotifications) {
          const permResult = await LocalNotifications.requestPermissions();
          granted = permResult.display === "granted";
          state.nativeDisplayPermission = permResult.display;
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
      queueNativeNotificationSync({ force: true, delay: 1200 });
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
      if (LocalNotifications) {
        const { notifications } = await LocalNotifications.getPending();
        if (notifications.length) await LocalNotifications.cancel({ notifications });
      }
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
  const active = state.notificationEnabled && (hasNativeNotif ? state.nativeDisplayPermission !== "denied" : Notification.permission === "granted");
  els.notificationBtn.setAttribute("aria-checked", active ? "true" : "false");
  const label = document.getElementById("notificationLabel");
  if (label) label.textContent = active ? "Notificaciones activadas" : "Activar notificación";
  updateNativeNotificationStatus();
}


function updateNativeNotificationStatus() {
  const status = document.getElementById("nativeNotificationStatus");
  if (!status) return;
  status.hidden = !isCapacitor() || !state.notificationEnabled;
  if (status.hidden) { status.textContent = ""; return; }
  if (state.nativeDisplayPermission === "denied") {
    status.textContent = "Permiso de notificaciones revocado. Actívalo en Ajustes > Notificaciones.";
  } else if (state.nativeNotificationError) {
    status.textContent = "No se pudieron programar los avisos. Se reintentará al volver a abrir la app.";
  } else if (state.nativeExactPermission === "denied") {
    status.textContent = "Sin permiso de alarmas exactas: los avisos pueden retrasarse. Actívalo en Ajustes > Aplicaciones > Acceso especial > Alarmas y recordatorios.";
  } else if (state.nativeNotificationsUntil) {
    const until = new Date(state.nativeNotificationsUntil);
    status.textContent = Number.isFinite(until.getTime())
      ? `Programados hasta el ${new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: state.timezone }).format(until)} (estrenos con hora confirmada).`
      : "Avisos pendientes de programar.";
  } else {
    status.textContent = "Avisos pendientes de programar.";
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
  if (els.syncAnilistBtn.disabled) return;
  try {
    const username = els.anilistInput.value.trim();
    if (!username) return showStatus("Pon tu usuario de AniList.", "error");
    const last = Date.parse(state.lastAnilistSync || "");
    if (state.lastAnilistSyncUsername === username && Number.isFinite(last) && Date.now() - last < ANILIST_MANUAL_COOLDOWN_MS) {
      return showStatus("AniList ya está sincronizado. Espera un minuto para volver a intentarlo.", "warn");
    }
    els.syncAnilistBtn.disabled = true;
    showStatus("Sincronizando tu biblioteca de AniList…", "success");
    const library = await refreshAnilistData(username);
    if (isCapacitor()) queueNativeNotificationSync({ force: true });
    render();
    showStatus(`AniList sincronizado: ${library.length} animes. Los horarios y plataformas se actualizan automáticamente.`, "success");
  } catch (error) { showStatus(error.message || "No se pudo sincronizar AniList.", "error"); }
  finally { els.syncAnilistBtn.disabled = false; }
}

function startAnilistAutoRefresh() {
  scheduleBackgroundTask(() => maybeRefreshAnilist({ silent: true }), isCapacitor() ? 24000 : 2500);
  setInterval(() => maybeRefreshAnilist({ silent: true }), ANILIST_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleBackgroundTask(() => maybeRefreshAnilist({ silent: true }), isCapacitor() ? 22000 : 1600);
  });
}

function startPublicAnilistAutoRefresh() {
  scheduleBackgroundTask(() => maybeRefreshPublicAnilist({ silent: true }), isCapacitor() ? 32000 : 4500);
  setInterval(() => maybeRefreshPublicAnilist({ silent: true }), PUBLIC_ANILIST_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleBackgroundTask(() => maybeRefreshPublicAnilist({ silent: true }), isCapacitor() ? 30000 : 3000);
  });
}

async function maybeRefreshPublicAnilist({ silent = true, force = false } = {}) {
  const last = Date.parse(state.lastPublicAnilistSync || "");
  if (!force && state.releases.length > 0 && Number.isFinite(last) && Date.now() - last < PUBLIC_ANILIST_REFRESH_MS) return false;
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
  renderAnilistSyncStatus();
  clearStaleAnilistFavorites();
  applyAnilistToReleases();
  reconcileAnilistFavoritesWithSchedule();
  applyCustomToReleases();
  applyUserOverridesToLists();
  await browserApi.storage.local.set({
    anilistUsername: username,
    anilistLibrary: state.anilistLibrary,
    anilistMap: state.anilistMap,
    releases: state.releases,
    userOverrides: state.userOverrides,
    customPlatforms: state.customPlatforms,
    customLinks: state.customLinks,
    lastAnilistSync: state.lastAnilistSync,
    lastAnilistSyncUsername: state.lastAnilistSyncUsername
  });
  return library;
}

async function refreshPublicAnilistData() {
  try { await enrichReleasesFromPublicAnilist(); } catch (e) { console.warn("AniList público no disponible:", e.message); }
  applyAnilistToReleases();
  applyCustomToReleases();
  applyUserOverridesToLists();
  state.lastPublicAnilistSync = new Date().toISOString();
  await browserApi.storage.local.set({
    releases: state.releases,
    anilistMap: state.anilistMap,
    userOverrides: state.userOverrides,
    customPlatforms: state.customPlatforms,
    customLinks: state.customLinks,
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
    const timezone = getSelectedTimezone();
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
    applyUserOverridesToLists();
    await browserApi.storage.local.set({ releases: state.releases, userOverrides: state.userOverrides, customPlatforms: state.customPlatforms, customLinks: state.customLinks, animeScheduleToken: token });
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

function refreshSharedSchedule(options = {}) {
  if (sharedRefreshPromise) return sharedRefreshPromise;
  sharedRefreshPromise = performSharedRefresh(options).finally(() => { sharedRefreshPromise = null; });
  return sharedRefreshPromise;
}

async function performSharedRefresh({ silent = false, skipPublicAnilist = false, force = false } = {}) {
  if (!isSharedScheduleConfigured()) return false;

  if (!force && silent && state.releases.length > 0) {
    const lastSync = Date.parse(state.lastSharedSync || "");
    if (Number.isFinite(lastSync) && Date.now() - lastSync < SHARED_SCHEDULE_REFRESH_MS) return false;
  }

  try {
    state.scheduleHealth = { ...state.scheduleHealth, loading: true };
    renderScheduleHealth();
    if (!silent) {
      if (els.importPreview) els.importPreview.innerHTML = `<div class="empty-message">Cargando horarios compartidos...</div>`;
      showStatus("Actualizando horarios compartidos...", "success");
    }

    const rows = await fetchSharedSchedule();
    if (state.scheduleHealth.stale && state.releases.some(item => policy.hasConfirmedTime(item) && Date.parse(item.releaseDate) > Date.now())) {
      throw new Error("El servidor devolvió un horario sin emisiones futuras; se conserva la copia local más reciente.");
    }
    await yieldToMainThread();
    const imported = rows.map(mapSharedRelease).map(enrichScheduleItem).map((item) => preserveExistingAnimeData(item));
    await yieldToMainThread();
    const localOnly = state.releases.filter((item) =>
      item.source !== "animeschedule-api" &&
      !String(item.source || "").startsWith("shared-json") &&
      !isAnilistMissingRelease(item) &&
      !isAniListTimedRelease(item) &&
      !isAnilistMissingCoveredBySchedule(item, imported)
    );
    state.releases = mergeDuplicateItems(mergeById(localOnly, imported));
    applyAnilistToReleases();
    reconcileAnilistFavoritesWithSchedule();
    applyCustomToReleases();
    applyUserOverridesToLists();
    state.lastSharedSync = new Date().toISOString();
    await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary, userOverrides: state.userOverrides, customPlatforms: state.customPlatforms, customLinks: state.customLinks, lastSharedSync: state.lastSharedSync, lastPlatformSync: state.lastPlatformSync, scheduleMetadata: { updatedAt: state.scheduleHealth.updatedAt, checkedAt: state.scheduleHealth.checkedAt, platforms: state.scheduleHealth.platforms } });
    renderPreview(imported);
    scheduleRender();
    checkReleaseNotifications();
    queueNativeNotificationSync({ force: true, delay: 100 });

    if (!silent) {
      showStatus(`Actualizados ${imported.length} episodios desde la base compartida.`, "success");
    }
    return true;
  } catch (error) {
    state.scheduleHealth = { ...state.scheduleHealth, loading: false, error: getFriendlyFetchError(error) };
    render();
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
  const recentSince = now.getTime() - RECENT_RELEASE_DAYS * 24 * 60 * 60 * 1000;
  const until = new Date(now.getTime() + PUBLIC_SCHEDULE_DAYS * 24 * 60 * 60 * 1000);
  let response;
  let bundled = false;
  try {
    response = await fetch(SHARED_SCHEDULE_URL, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Horario HTTP ${response.status}`);
  } catch (error) {
    if (!isCapacitor() || state.releases.length) throw error;
    response = await fetch("./schedule.json", { cache: "no-store" });
    bundled = true;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`El horario compartido respondio ${response.status}: ${body.slice(0, 120)}`);
  }

  let json;
  try { json = await response.json(); } catch (_) {
    throw new Error("La respuesta del horario compartido no es JSON válido.");
  }
  const rows = policy.validate(json);
  state.scheduleHealth = { ...policy.health(json), platforms: json.platforms || null, loading: false, bundled, error: "" };
  const filtered = rows.filter((row) => {
    if (!isAnimeScheduleBackedRow(row, json)) return false;
    if (row.inferredFromAnimeSchedule || row.inferred_from_animeschedule) return false;
    if (policy.isPending(row) || row.scheduleStatus === "cancelled") return true;
    const releaseDate = getSharedSubReleaseDate(row);
    const releaseAt = Date.parse(releaseDate);
    if (!Number.isFinite(releaseAt)) return false;
    return releaseAt >= recentSince && releaseAt <= until.getTime();
  });
  return filtered;
}

function isAnimeScheduleBackedRow(row, payload) {
  const payloadSource = String(payload?.source || "").toLowerCase();
  const rowSource = String(row?.source || "").toLowerCase();
  if (payloadSource && !payloadSource.includes("animeschedule")) return false;
  if (rowSource && (rowSource.includes("public-anilist") || rowSource === "anilist")) return false;
  return true;
}

function mapSharedRelease(row) {
  const releaseDate = getSharedSubReleaseDate(row);
  const title = row.title || "Sin titulo";
  const episodeNumber = row.episode_number ?? row.episodeNumber ?? "?";
  return sanitizePlatformFields(platformPolicy.applyCountryPlatforms({
    id: row.id || stableId("schedule", title, episodeNumber, releaseDate),
    animeKey: row.anime_key || row.animeKey || stableId(title),
    title,
    route: row.route || "",
    episode: row.episode || `Ep ${episodeNumber}`,
    episodeNumber,
    airType: row.air_type || row.airType || "SUB",
    delayed: Boolean(row.delayed) || isDelayed(row),
    scheduleStatus: row.scheduleStatus || "scheduled",
    confirmedSubDate: row.confirmedSubDate || "",
    officialEvidence: row.officialEvidence || [],
    officialSources: row.officialSources || [],
    lastDelayCheck: row.lastDelayCheck || "",
    delayCheckError: row.delayCheckError || "",
    releaseDate: releaseDate && Number.isFinite(Date.parse(releaseDate)) ? new Date(releaseDate).toISOString() : null,
    originalReleaseDate: row.originalReleaseDate || row.original_release_date || "",
    basePlatforms: row.basePlatforms,
    anilistOffers: row.anilistOffers || [],
    ...(row.isAdult === true ? { isAdult: true } : {}),
    platformsByCountry: row.platformsByCountry || {},
    service: row.service || "No legal platform",
    serviceUrl: normalizeUrl(row.service_url || row.serviceUrl || ""),
    allServices: row.all_services || row.allServices || [],
    hasAllowedPlatform: row.has_allowed_platform ?? row.hasAllowedPlatform ?? Boolean(row.service_url || row.serviceUrl),
    source: row.source === "anilist-missing" ? "anilist-missing" : "shared-json",
    sharedSchedule: true,
    inferredFromAnimeSchedule: Boolean(row.inferredFromAnimeSchedule || row.inferred_from_animeschedule),
    favorite: false,
    coverUrl: normalizeUrl(row.cover_url || row.coverUrl || ""),
    anilistId: row.anilistId || row.anilist_id,
    anilistTitle: row.anilistTitle || row.anilist_title || "",
    anilistUrl: row.anilistUrl || row.anilist_url || "",
    anilistFormat: row.anilistFormat || row.anilist_format || "",
    anilistScore: row.anilistScore ?? row.anilist_score,
    titles: row.titles || [],
    customUrl: "",
    customPlatformName: ""
  }, state.jwCountry));
}

function preserveExistingAnimeData(item) {
  const existing = findExistingRelease(item);
  const override = getUserOverride(item);
  if (!existing) return applyUserOverride(item, override);
  const base = {
    ...item,
    favorite: Boolean(item.favorite || existing.favorite || override?.favorite),
    delayed: Boolean(item.delayed),
    originalReleaseDate: item.originalReleaseDate || existing.originalReleaseDate || "",
    anilistId: item.anilistId || existing.anilistId,
    anilistTitle: item.anilistTitle || existing.anilistTitle,
    anilistUrl: item.anilistUrl || existing.anilistUrl,
    anilistScore: item.anilistScore ?? existing.anilistScore,
    coverUrl: item.coverUrl || existing.coverUrl,
    customUrl: override?.customUrl || item.customUrl || existing.customUrl || "",
    customPlatformName: override?.customPlatformName || item.customPlatformName || existing.customPlatformName || ""
  };
  return applyUserOverride(base, override);
}

function findExistingRelease(item) {
  const idMatch = state.releases.find((release) => release.id === item.id);
  if (idMatch) return idMatch;
  if (item.anilistId) {
    const anilistMatch = state.releases.find((release) => String(release.anilistId || "") === String(item.anilistId));
    if (anilistMatch) return anilistMatch;
  }
  const episodeKey = getEpisodeKey(item);
  const episodeMatch = state.releases.find((release) => getEpisodeKey(release) === episodeKey);
  if (episodeMatch) return episodeMatch;
  const seriesKey = getSeriesKey(item);
  return state.releases.find((release) => getSeriesKey(release) === seriesKey) ||
    state.releases.find((release) => getSeriesMatchScore(release, item) >= 0.78);
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
  return fetchAnimeSchedule("anime", { season, year, tz: timezone }, token);
}
async function fetchTimetable(weekInfo, timezone, token) {
  return fetchAnimeSchedule("timetable", { year: weekInfo.year, week: weekInfo.week, tz: timezone }, token);
}
async function fetchAnimeSchedule(endpoint, values, token) {
  const authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const response = await fetch(`/api/${endpoint}?${new URLSearchParams(values)}`, {
    headers: { accept: "application/json", authorization }
  });
  if (!response.ok && response.status !== 404) throw new Error(`AnimeSchedule:${response.status}`);
  return response;
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
    const releaseDate = getAnimeScheduleSubReleaseDate(item);
    const normalizedReleaseDate = normalizeScheduleDate(releaseDate);
    if (!normalizedReleaseDate) continue;
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
      releaseDate: normalizedReleaseDate,
      originalReleaseDate: normalizeScheduleDate(getAnimeScheduleOriginalReleaseDate(item)) || "",
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

function getAnimeScheduleSubReleaseDate(item) {
  return firstDateValue(
    item.subDelayedTimetable,
    item.sub_delayed_timetable,
    item.subDelayedUntil,
    item.sub_delayed_until,
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

function normalizeScheduleDate(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0001-") || raw.startsWith("0002-")) return "";
  const isoish = raw.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoish);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoish)) {
    try { return zonedLocalIsoToUtcIso(isoish, getSelectedTimezone()); } catch (_) {}
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const parsedIsoish = Date.parse(isoish);
  return Number.isFinite(parsedIsoish) ? new Date(parsedIsoish).toISOString() : "";
}

function getStreams(item) { if (Array.isArray(item.streams)) return item.streams; if (Array.isArray(item.websites?.streams)) return item.websites.streams; if (Array.isArray(item.website?.streams)) return item.website.streams; return []; }
function normalizeStream(stream) { const platform = String(stream.platform || stream.name || "").toLowerCase(); const service = platformToService(platform); return { platform, service, url: stream.url || "" }; }
function platformToService(platform) {
  const value = String(platform || "").toLowerCase().trim();
  const subscription = Object.keys(SUBSCRIPTIONS).find(name => SUBSCRIPTIONS[name].some(alias => alias.toLowerCase() === value));
  if (subscription) return subscription;
  const aliases = { crunchyroll: "Crunchyroll", netflix: "Netflix", amazon: "Prime Video", "amazon prime video": "Prime Video", primevideo: "Prime Video", disney: "Disney+", disneyplus: "Disney+", "disney plus": "Disney+" };
  return aliases[value] || null;
}
function chooseBestStream(streams) { return [...streams].sort((a,b) => (SERVICE_PRIORITY[a.service] || 50) - (SERVICE_PRIORITY[b.service] || 50))[0] || null; }
function normalizeAllowedService(service) { const mapped = platformToService(String(service || "").toLowerCase()) || String(service || "").trim(); return mapped || ""; }
function sanitizePlatformFields(item) {
  item = { ...item };
  for (const key of ["titles", "genres", "tags", "allServices", "officialEvidence", "officialSources"]) {
    if (!Array.isArray(item[key])) item[key] = [];
  }
  const normalizeService = item.jwSource === "shared" ? value => String(value || "").trim() : normalizeAllowedService;
  const normalizedService = normalizeService(item.service);
  const service = normalizedService === "No legal platform" ? "" : normalizedService;
  const allServices = [...new Set((item.allServices || []).map(normalizeService).filter((value) => value && value !== "No legal platform"))];
  return {
    ...item,
    service: service || "No legal platform",
    serviceUrl: service ? normalizeUrl(item.serviceUrl || "") : "",
    allServices,
    hasAllowedPlatform: Boolean(service)
  };
}

function isAniListTimedRelease(item) {
  const source = String(item?.source || "").toLowerCase();
  if (source === "public-anilist" || source === "anilist") return true;
  if (source === "anilist-library" && item?.releaseDate) return true;
  return String(item?.id || "").toLowerCase().startsWith("public-anilist-");
}

function isAnilistMissingRelease(item) {
  return String(item?.source || "").toLowerCase() === "anilist-missing";
}

function isAnilistMissingCoveredBySchedule(item, scheduledItems = state.releases) {
  return isAnilistMissingRelease(item) && hasScheduledSeriesMatch(item, scheduledItems);
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

function isDelayed(item) {
  const status = String(item.delayedTimetable || item.subDelayedTimetable || item.status || item.airingStatus || "").trim().toLowerCase();
  const releaseAt = Date.parse(normalizeScheduleDate(getAnimeScheduleSubReleaseDate(item)));
  const originalAt = parseRealDate(normalizeScheduleDate(getAnimeScheduleOriginalReleaseDate(item)));
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
    service: item.service || "No legal platform",
    serviceUrl: item.serviceUrl || "",
    allServices: item.allServices || [],
    hasAllowedPlatform,
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
    return entry.status === "CURRENT" && Boolean(media?.id);
  }).map((entry) => {
    const media = entry.media;
    const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);
    const title = media.title?.english || media.title?.romaji || media.title?.native || "Sin título";
    return sanitizePlatformFields({
      id: `anilist-${media.id}`,
      animeKey: stableId(title),
      title,
      titles,
      episode: media.nextAiringEpisode?.episode ? `Ep ${media.nextAiringEpisode.episode}` : "Sin episodio confirmado",
      episodeNumber: media.nextAiringEpisode?.episode || null,
      airType: "SUB",
      delayed: false,
      releaseDate: "",
      anilistAiringDate: media.nextAiringEpisode?.airingAt ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString() : "",
      service: "No legal platform",
      serviceUrl: "",
      allServices: [],
      hasAllowedPlatform: false,
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
  addMissingReleasesFromPublicAnilist(catalog);
  await enrichMissingScoresBySearch();
}

function addMissingReleasesFromPublicAnilist(catalog) {
  const now = Date.now();
  const scheduleBase = state.releases.filter((item) =>
    (!isAnilistMissingRelease(item) || item.sharedSchedule) && !isAniListTimedRelease(item)
  );
  const missing = [];

  for (const media of catalog) {
    const releaseAt = Date.parse(media.releaseDate || "");
    if (!Number.isFinite(releaseAt) || releaseAt <= now) continue;
    if (!isSchedulableItem(media)) continue;
    if (!isSeasonalSeriesItem(media)) continue;
    if (hasScheduledSeriesMatch(media, scheduleBase)) continue;
    missing.push(mapPublicAnilistMissingRelease(media));
  }

  state.releases = mergeDuplicateItems(scheduleBase.concat(missing));
}

function mapPublicAnilistMissingRelease(media) {
  const releaseDate = new Date(media.releaseDate).toISOString();
  const episodeNumber = String(media.episodeNumber || parseEpisodeNumber(media.episode) || "?");
  const title = media.title || "Sin título";
  return sanitizePlatformFields({
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
    episodeNumber,
    airType: "SUB",
    delayed: false,
    releaseDate,
    originalReleaseDate: "",
    service: media.service || "No legal platform",
    serviceUrl: normalizeUrl(media.serviceUrl || media.siteUrl || ""),
    allServices: media.allServices || [],
    hasAllowedPlatform: Boolean(media.hasAllowedPlatform),
    source: "anilist-missing",
    favorite: false,
    coverUrl: normalizeUrl(media.coverUrl || "")
  });
}

async function enrichMissingScoresBySearch() {
  const candidates = getOneNextPerSeries(state.releases)
    .filter((item) => !item.anilistScore);
  const cache = new Map();
  const batchSize = 5;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    await Promise.all(batch.map(async (item) => {
      const key = getSeriesKey(item);
      if (!cache.has(key)) cache.set(key, await fetchPublicAnilistSearchMatch(item));
      const media = cache.get(key);
      if (media) applyPublicAnilistDataToSeries(key, media);
    }));
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

async function fetchPublicAnilistCatalog() {
  const catalog = [];
  const seen = new Set();
  const now = Math.floor(Date.now() / 1000);
  for (let page = 1; page <= ANILIST_AIRING_MAX_PAGES; page++) {
    const chunk = await fetchAnilistAiringPage(page, now);
    for (const media of chunk.items) {
      if (!media?.anilistId || seen.has(media.anilistId)) continue;
      seen.add(media.anilistId);
      catalog.push(media);
    }
    if (!chunk.hasNextPage) break;
    await yieldToMainThread();
  }
  return catalog;
}

async function fetchAnilistAiringPage(page, now) {
  const query = `query ($page: Int, $now: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(airingAt_greater: $now, sort: TIME) { episode airingAt media { id title { romaji english native } synonyms format genres isAdult coverImage { large medium } siteUrl episodes status averageScore meanScore nextAiringEpisode { episode airingAt } tags { name isAdult rank } externalLinks { site url type } streamingEpisodes { site url title thumbnail } } } } }`;
  const variables = { page, now };
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
    isAdult: Boolean(media.isAdult),
    genres: media.genres || [],
    tags: media.tags || [],
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
    return {
      ...item,
      anilistId: media.anilistId || item.anilistId,
      anilistTitle: media.title || item.anilistTitle,
      anilistUrl: media.siteUrl || item.anilistUrl,
      anilistFormat: media.anilistFormat || item.anilistFormat,
      anilistScore: media.anilistScore ?? item.anilistScore,
      excludeFromSchedule: item.excludeFromSchedule || (String(media.anilistFormat || "").toUpperCase() === "MOVIE" && parseEpisodeNumber(item.episodeNumber ?? item.episode) === 1),
      coverUrl: media.coverUrl || item.coverUrl
    };
  });
}

function getSharedSubReleaseDate(row) {
  const original = row.originalReleaseDate || row.original_release_date || "";
  if (policy.isPending(row) || row.scheduleStatus === "cancelled") return "";
  return row.release_date || row.releaseDate || "";
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
    if (getUserOverride(item)?.favorite === true) return item;
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
    // An AniList ID is authoritative. Falling back to a similar title here can
    // merge the main series with a spin-off, short or special.
    return byId || null;
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
  return { title: match.title || item.title };
}

function getAnilistAiringDate(match) {
  return match?.releaseDate || match?.anilistAiringDate || "";
}
function parseEpisodeNumber(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}
function applyCustomToReleases() { state.releases = state.releases.map(applyCustom); state.anilistLibrary = state.anilistLibrary.map(applyCustom); }
function applyCustom(item) { const override = getUserOverride(item); const key=getAnimeKey(item); const customUrl=normalizeUrl(override?.customUrl || state.customLinks[key] || item.customUrl || ""); const customPlatformName=override?.customPlatformName || state.customPlatforms[key] || item.customPlatformName || ""; return { ...item, customUrl, customPlatformName }; }
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

function migrateLegacyUserOverrides() {
  for (const item of [...state.releases, ...state.anilistLibrary]) {
    if (item.favorite || item.customUrl || item.customPlatformName) {
      upsertUserOverride(item, {
        favorite: item.favorite ? true : undefined,
        customUrl: item.customUrl || undefined,
        customPlatformName: item.customPlatformName || undefined
      });
    }
  }

  for (const [key, url] of Object.entries(state.customLinks)) {
    if (!url && !state.customPlatforms[key]) continue;
    const existingKey = findOverrideKeyByAlias(key) || key;
    state.userOverrides[existingKey] = {
      ...(state.userOverrides[existingKey] || {}),
      keys: [...new Set([...(state.userOverrides[existingKey]?.keys || []), key])],
      customUrl: normalizeUrl(url || state.userOverrides[existingKey]?.customUrl || ""),
      customPlatformName: state.customPlatforms[key] || state.userOverrides[existingKey]?.customPlatformName || "",
      updatedAt: new Date().toISOString()
    };
  }
}

function applyUserOverridesToLists() {
  state.releases = state.releases.map((item) => applyUserOverride(item, getUserOverride(item)));
  state.anilistLibrary = state.anilistLibrary.map((item) => applyUserOverride(item, getUserOverride(item)));
}

function applyUserOverride(item, override) {
  if (!override) return item;
  const customUrl = normalizeUrl(Object.hasOwn(override, "customUrl") ? override.customUrl : item.customUrl || "");
  const customPlatformName = Object.hasOwn(override, "customPlatformName") ? override.customPlatformName : item.customPlatformName || "";
  return {
    ...item,
    favorite: Object.prototype.hasOwnProperty.call(override, "favorite") ? Boolean(override.favorite) : item.favorite,
    customUrl,
    customPlatformName
  };
}

function upsertUserOverride(item, values = {}) {
  const keys = getOverrideKeys(item);
  const existingKey = keys.map(findOverrideKeyByAlias).find(Boolean) || keys[0] || getAnimeKey(item);
  const current = state.userOverrides[existingKey] || {};
  const next = {
    ...current,
    title: item.title || current.title || "",
    anilistId: item.anilistId || current.anilistId || "",
    keys: [...new Set([...(current.keys || []), ...keys])],
    updatedAt: new Date().toISOString()
  };

  if (Object.prototype.hasOwnProperty.call(values, "favorite") && values.favorite !== undefined) next.favorite = Boolean(values.favorite);
  if (Object.prototype.hasOwnProperty.call(values, "customUrl") && values.customUrl !== undefined) next.customUrl = normalizeUrl(values.customUrl || "");
  if (Object.prototype.hasOwnProperty.call(values, "customPlatformName") && values.customPlatformName !== undefined) next.customPlatformName = values.customPlatformName || "";
  if (Object.prototype.hasOwnProperty.call(values, "activeLink")) {
    if (values.activeLink === "auto") delete next.activeLink;
    else next.activeLink = values.activeLink;
  }
  state.userOverrides[existingKey] = next;
  return next;
}

function getUserOverride(item) {
  const key = getOverrideKeys(item).map(findOverrideKeyByAlias).find(Boolean);
  return key ? state.userOverrides[key] : null;
}

function findOverrideKeyByAlias(alias) {
  if (!alias) return "";
  if (state.userOverrides[alias]) return alias;
  return Object.keys(state.userOverrides).find((key) => {
    const override = state.userOverrides[key] || {};
    return Array.isArray(override.keys) && override.keys.includes(alias);
  }) || "";
}

function getOverrideKeys(item) {
  return [...new Set([
    item.anilistId ? `anilist-${item.anilistId}` : "",
    getSeriesKey(item),
    getAnimeKey(item),
    item.anilistTitle ? stableId(item.anilistTitle) : "",
    item.title ? stableId(item.title) : "",
    ...(item.titles || []).map(stableId)
  ].filter(Boolean))];
}

async function saveSanitizedState() {
  invalidateDataCaches();
  await browserApi.storage.local.set({
    releases: state.releases,
    anilistLibrary: state.anilistLibrary,
    customPlatforms: state.customPlatforms,
    customLinks: state.customLinks,
    userOverrides: state.userOverrides
  });
}

async function handleListClick(event) {
  const actionEl = event.target.closest("[data-action]");
  const card = event.target.closest(".anime-card");
  const action = actionEl?.dataset.action || card?.dataset.action;
  const id = actionEl?.dataset.id || card?.dataset.id;
  if (!action || $("linkDialog").open) return;
  event.stopPropagation();
  if (action === "open") { const item = findItemById(id); if (item) await openOrAsk(item); return; }
  if (action === "secondary") {
    const item = findItemById(id);
    const url = item && getSecondaryWatchSource(item)?.url;
    if (url) browserApi.tabs.create({ url });
    return;
  }
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
  const url = event.target.closest('[data-action="secondary"]') ? getSecondaryWatchSource(item)?.url : getBestWatchUrl(item);
  if (url) window.open(url, "_blank", "noopener");
}

async function toggleFavorite(key) {
  const should = !getAllItems().some(item => getAnimeKey(item) === key && item.favorite);
  const sample = findItemByKey(key) || { animeKey: key, title: key };
  upsertUserOverride(sample, { favorite: should });
  state.releases = state.releases.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item);
  state.anilistLibrary = state.anilistLibrary.map(item => getAnimeKey(item) === key ? { ...item, favorite: should } : item);
  await saveAllLists();

  if (isCapacitor() && state.notificationEnabled) {
    queueNativeNotificationSync({ force: true, delay: 1200 });
  }

  const btn = els.animeList.querySelector(`[data-action="favorite"][data-key="${CSS.escape(key)}"]`);

  if (!should) {
    render();
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
let linkDialogItem = null;
let linkDialogReturn = null;
let releaseCardClick = false;

function currentDialogItem() {
  return linkDialogItem && (findItemById(linkDialogItem.id) || findItemByKey(getAnimeKey(linkDialogItem)) || linkDialogItem);
}
function renderLinkOptions() {
  const item = currentDialogItem();
  if (!item || !$("linkDialog").open) return;
  const sources = getWatchSources(item);
  const automatic = getAutomaticWatchSource(item, sources);
  const saved = getUserOverride(item)?.activeLink;
  const selected = sources.some(source => source.id === saved) ? saved : "auto";
  const options = [{ id: "auto", label: `Automático (${automatic?.label || "Sin plataforma"})` }, ...sources.map(source => ({
    id: source.id,
    label: source.kind === "platform" ? `${source.label}${state.hiddenPlatforms.includes(source.service) ? " (desmarcada)" : ""}`
      : source.kind === "custom" ? `Enlace propio (${source.label})` : source.label
  }))];
  const container = $("activeLinkOptions");
  const focused = container.contains(document.activeElement) ? document.activeElement.value : null;
  const html = '<legend>Enlace activo</legend>' + options.map(option => `<label class="link-option"><input type="radio" name="activeLink" value="${escapeHtml(option.id)}"${option.id === selected ? " checked" : ""} /><span>${escapeHtml(option.label)}</span></label>`).join("");
  if (container.innerHTML !== html) {
    container.innerHTML = html;
    if (focused) [...container.querySelectorAll("input")].find(input => input.value === focused)?.focus();
  }
}
function openLinkDialog(item, card, focusCustom = false) {
  if (!els.settingsPanel.classList.contains("hidden")) setSettingsOpen(false);
  linkDialogItem = item;
  linkDialogReturn = { card, id: item.id, key: getAnimeKey(item) };
  $("linkDialogTitle").textContent = item.title;
  $("customLinkName").value = item.customPlatformName || "";
  $("customLinkAddress").value = item.customUrl || "";
  $("customLinkError").hidden = true;
  $("customLinkAddress").setAttribute("aria-invalid", "false");
  $("linkDialogStatus").textContent = "";
  $("removeDialogLink").disabled = !normalizeUrl(item.customUrl);
  if (!$("linkDialog").open) $("linkDialog").showModal();
  document.body.classList.add("link-dialog-open");
  renderLinkOptions();
  (focusCustom ? $("customLinkName") : $("closeLinkDialog")).focus({ preventScroll: true });
}
function closeLinkDialog() { if ($("linkDialog").open) $("linkDialog").close(); }
function validateCustomLink(value) {
  try {
    const url = new URL(normalizeUrl(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
async function saveDialogCustomLink(event) {
  event.preventDefault();
  const item = currentDialogItem();
  if (!item) return;
  const url = validateCustomLink($("customLinkAddress").value.trim());
  $("customLinkError").hidden = Boolean(url);
  $("customLinkAddress").setAttribute("aria-invalid", String(!url));
  if (!url) { $("customLinkAddress").focus(); return; }
  const name = $("customLinkName").value.trim();
  const key = getAnimeKey(item);
  state.customLinks[key] = url;
  state.customPlatforms[key] = name;
  upsertUserOverride(item, { customUrl: url, customPlatformName: name });
  applyCustomToReleases();
  applyUserOverridesToLists();
  await saveAllLists();
  queueNativeNotificationSync({ force: true });
  $("removeDialogLink").disabled = false;
  $("linkDialogStatus").textContent = "Enlace guardado.";
  render();
  renderLinkOptions();
}
async function saveDialogActiveLink(value) {
  const item = currentDialogItem();
  if (!item) return;
  upsertUserOverride(item, { activeLink: value });
  await saveAllLists();
  queueNativeNotificationSync({ force: true });
  render();
  renderLinkOptions();
}
function bindLinkDialog() {
  const dialog = $("linkDialog");
  $("closeLinkDialog").addEventListener("click", closeLinkDialog);
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeLinkDialog(); });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("link-dialog-open");
    const target = linkDialogReturn;
    linkDialogItem = null;
    linkDialogReturn = null;
    const card = target?.card?.isConnected ? target.card
      : target && (els.animeList.querySelector(`.anime-card[data-id="${CSS.escape(target.id)}"]`) || els.animeList.querySelector(`.anime-card[data-key="${CSS.escape(target.key)}"]`));
    (card || els.showAllBtn).focus({ preventScroll: true });
  });
  dialog.addEventListener("click", event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeLinkDialog();
  });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled)")]
      .filter(node => node.type !== "radio" || node.checked);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $("activeLinkOptions").addEventListener("change", event => {
    if (event.target.matches('input[name="activeLink"]')) saveDialogActiveLink(event.target.value);
  });
  $("activeLinkOptions").addEventListener("click", event => {
    // The fallback radio is already checked. An explicit click still clears the saved unavailable choice.
    if (!event.target.matches('input[value="auto"]')) return;
    const item = currentDialogItem();
    const saved = item && getUserOverride(item)?.activeLink;
    if (saved && !getWatchSources(item).some(source => source.id === saved)) saveDialogActiveLink("auto");
  });
  $("customLinkForm").addEventListener("submit", saveDialogCustomLink);
  $("removeDialogLink").addEventListener("click", async () => {
    const item = currentDialogItem();
    if (!item) return;
    await removePlatform(getAnimeKey(item));
    $("customLinkName").value = "";
    $("customLinkAddress").value = "";
    $("customLinkError").hidden = true;
    $("customLinkAddress").setAttribute("aria-invalid", "false");
    $("removeDialogLink").disabled = true;
    $("linkDialogStatus").textContent = "Enlace quitado.";
    renderLinkOptions();
  });
}
function bindCardGestures() {
  let press = null;
  const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
  // A new press is separate from the release click of the long press that opened the dialog.
  document.addEventListener("pointerdown", () => { releaseCardClick = false; }, true);
  document.addEventListener("click", event => {
    if (!releaseCardClick) return;
    releaseCardClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  els.animeList.addEventListener("pointerdown", event => {
    cancel();
    if (event.button !== 0 || event.isPrimary === false || event.target.closest("button, a, input, select, textarea, label")) return;
    const card = event.target.closest(".anime-card");
    if (!card) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, card };
    press.timer = setTimeout(() => {
      const target = press?.card;
      cancel();
      if (!target?.isConnected) return;
      const item = findItemById(target.dataset.id);
      if (item) { releaseCardClick = true; openLinkDialog(item, target); }
    }, 500);
  });
  document.addEventListener("pointermove", event => {
    if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancel();
  }, { passive: true });
  document.addEventListener("pointerup", cancel, { passive: true });
  document.addEventListener("pointercancel", cancel, { passive: true });
  window.addEventListener("blur", cancel);
  window.addEventListener("scroll", cancel, { passive: true, capture: true });
  els.animeList.addEventListener("contextmenu", event => {
    const card = event.target.closest(".anime-card");
    if (!card) return;
    const releasingPress = Boolean(press);
    event.preventDefault(); cancel();
    const item = findItemById(card.dataset.id);
    if (item && !$("linkDialog").open) {
      releaseCardClick ||= releasingPress;
      openLinkDialog(item, card);
    }
  });
  els.animeList.addEventListener("dragstart", event => { if (event.target.closest(".anime-card")) event.preventDefault(); });
}

async function associatePlatform(key) {
  const item = findItemByKey(key);
  if (item) openLinkDialog(item, document.querySelector(`.anime-card[data-id="${CSS.escape(item.id)}"]`), true);
}
async function removePlatform(key) {
  const item = findItemByKey(key);
  if (!item) return;
  const override = getUserOverride(item);
  const matches = other => getSeriesKey(other) === getSeriesKey(item) || (override && getUserOverride(other) === override);
  const affected = state.releases.concat(state.anilistLibrary).filter(matches);
  const keys = new Set([key, ...(override?.keys || []), ...affected.flatMap(getOverrideKeys)]);
  for (const alias of keys) { delete state.customPlatforms[alias]; delete state.customLinks[alias]; }
  state.releases = state.releases.map(other => matches(other) ? { ...other, customUrl: "", customPlatformName: "" } : other);
  state.anilistLibrary = state.anilistLibrary.map(other => matches(other) ? { ...other, customUrl: "", customPlatformName: "" } : other);
  upsertUserOverride(item, { customUrl: "", customPlatformName: "" });
  await saveAllLists();
  queueNativeNotificationSync({ force: true });
  render();
}

async function openOrAsk(item) {
  const url = getBestWatchUrl(item);
  if (url) browserApi.tabs.create({ url });
  else await associatePlatform(getAnimeKey(item));
}
async function resetAll() {
  if (!confirm("¿Seguro que quieres borrar todos tus favoritos?")) return;
  state.releases = state.releases.map(item => ({ ...item, favorite: false }));
  state.anilistLibrary = state.anilistLibrary.map(item => ({ ...item, favorite: false }));
  for (const override of Object.values(state.userOverrides)) {
    if (override) override.favorite = false;
  }
  await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary, userOverrides: state.userOverrides });
  render();
  queueNativeNotificationSync({ force: true });
  showStatus("Favoritos borrados.", "success");
}

function startNotificationScheduler() {
  checkReleaseNotifications();
  if (isCapacitor()) {
    queueNativeNotificationSync({ delay: 12000 });
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

function queueNativeNotificationSync({ force = false, delay = 4000 } = {}) {
  if (!isCapacitor() || !state.notificationEnabled) return;
  if (nativeNotificationSyncTimer && nativeNotificationSyncForce && !force) return;
  nativeNotificationSyncForce ||= force;
  if (nativeNotificationSyncTimer) clearTimeout(nativeNotificationSyncTimer);
  nativeNotificationSyncTimer = setTimeout(() => {
    nativeNotificationSyncTimer = null;
    const forceSync = nativeNotificationSyncForce;
    nativeNotificationSyncForce = false;
    syncNativeNotificationsIfNeeded({ force: forceSync });
  }, delay);
}

async function syncNativeNotificationsIfNeeded({ force = false } = {}) {
  if (!isCapacitor() || !state.notificationEnabled) return 0;
  if (nativeNotificationSyncRunning) {
    // Even a normal request must reconcile changes made during the active run.
    nativeNotificationSyncPending = true;
    return 0;
  }
  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) return 0;
  nativeNotificationSyncRunning = true;
  let scheduled = 0;
  try {
    do {
      nativeNotificationSyncPending = false;
      const forceSync = force;
      force = true;
      try {
        const previousDisplay = state.nativeDisplayPermission;
        const previousExact = state.nativeExactPermission;
        state.nativeDisplayPermission = (await LocalNotifications.checkPermissions()).display;
        state.nativeExactPermission = (await LocalNotifications.checkExactNotificationSetting()).exact_alarm;
        updateNotificationButton();
        if (state.nativeDisplayPermission !== "granted") continue;
        const last = Date.parse(state.lastNativeNotificationSync || "");
        const migrate = state.nativeNotificationVersion !== NATIVE_NOTIFICATION_VERSION;
        const permissionRestored = previousDisplay === "denied" || (previousExact !== "granted" && state.nativeExactPermission === "granted");
        if (!forceSync && !migrate && !permissionRestored && !state.nativeNotificationError && Number.isFinite(last) && Date.now() - last < NATIVE_NOTIFICATION_SYNC_MS) continue;
        await createNativeNotificationChannel(LocalNotifications);
        await yieldToMainThread();
        if (migrate) {
          const { notifications } = await LocalNotifications.getPending();
          if (notifications.length) await LocalNotifications.cancel({ notifications });
        }
        await cancelStaleNativeNotifications();
        await yieldToMainThread();
        if (!state.notificationEnabled) continue;
        const windowEnd = Date.now() + NATIVE_NOTIFICATION_WINDOW_MS;
        scheduled += await scheduleNativeNotifications(windowEnd);
        // Disabling while the bridge was scheduling must also cancel that batch.
        if (!state.notificationEnabled) {
          const { notifications } = await LocalNotifications.getPending();
          if (notifications.length) await LocalNotifications.cancel({ notifications });
          continue;
        }
        const completed = {
          lastNativeNotificationSync: new Date().toISOString(),
          nativeNotificationVersion: NATIVE_NOTIFICATION_VERSION,
          nativeNotificationsUntil: new Date(windowEnd).toISOString()
        };
        await browserApi.storage.local.set(completed);
        Object.assign(state, completed);
        state.nativeNotificationError = false;
      } catch (error) {
        state.nativeNotificationError = true;
        console.warn("Error al sincronizar notificaciones nativas:", error);
      } finally {
        updateNotificationButton();
      }
    } while (nativeNotificationSyncPending && state.notificationEnabled);
    return scheduled;
  } finally {
    nativeNotificationSyncRunning = false;
  }
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

let notificationCheckRunning = false;
async function checkReleaseNotifications() {
  if (isCapacitor()) { queueNativeNotificationSync(); return; }
  if (notificationCheckRunning) return;
  if (!state.notificationEnabled) return;
  if (!isCapacitor() && (!("Notification" in window) || Notification.permission !== "granted")) return;
  notificationCheckRunning = true;
  try {
  const now = Date.now();
  const favorites = getFavoriteItems();
  const candidates = getDueNotificationItems(favorites, now);
  let changed = false;

  for (const item of candidates) {
    const releaseAt = new Date(item.releaseDate).getTime();
    if (!Number.isFinite(releaseAt)) continue;
    const diff = releaseAt - now;
    if (diff > NOTIFICATION_LEAD_MS || diff < -NOTIFICATION_GRACE_MS) continue;
    const key = `${item.id}|${new Date(item.releaseDate).toISOString()}`;
    if (state.notifiedReleaseIds[key]) continue;

    await showReleaseNotification(item);
    state.notifiedReleaseIds[key] = true;
    changed = true;
  }

  if (changed) await browserApi.storage.local.set({ notifiedReleaseIds: state.notifiedReleaseIds });
  } catch (error) { console.warn("No se pudo mostrar el aviso de estreno.", error); }
  finally { notificationCheckRunning = false; }
}

function getDueNotificationItems(items, now = Date.now()) {
  const due = items.filter((item) => {
    if (!policy.hasConfirmedTime(item)) return false;
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
  const url = getBestWatchUrl(item) || location.href;
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
    const registration = "serviceWorker" in navigator ? await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(() => resolve(null), 3000))]) : null;
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

async function createNativeNotificationChannel(LocalNotifications) {
  try {
    await LocalNotifications.createChannel({
      id: NATIVE_NOTIFICATION_CHANNEL,
      name: "Estrenos de Anime",
      description: "Notificaciones de episodios al momento del estreno",
      importance: 4,
      visibility: 1,
      vibration: true
    });
  } catch (error) {
    // The plugin reports UNAVAILABLE on Android < 8, where channels don't exist.
    if (error.code !== "UNAVAILABLE") throw error;
  }
}

async function scheduleNativeNotifications(windowEnd = Date.now() + NATIVE_NOTIFICATION_WINDOW_MS) {
  if (!isCapacitor() || !state.notificationEnabled) return 0;
  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) throw new Error("Plugin de notificaciones no disponible");

  const now = Date.now();
  const favorites = state.releases.filter((item) => item.favorite);
  const toSchedule = [];

  for (const item of favorites) {
    if (!policy.hasConfirmedTime(item)) continue;
    const releaseAt = new Date(item.releaseDate).getTime();
    if (!Number.isFinite(releaseAt) || releaseAt <= now) continue;
    if (releaseAt > windowEnd) continue;
    const notifId = hashNotificationId(item);

    const displayService = getDisplayService(item);
    toSchedule.push({
      id: notifId,
      title: `${item.title} ${item.episode}`,
      body: displayService === "No legal platform" ? "Ya disponible." : `Ya disponible en ${displayService}.`,
      schedule: { at: new Date(releaseAt), allowWhileIdle: true },
      channelId: NATIVE_NOTIFICATION_CHANNEL,
      extra: { url: getBestWatchUrl(item) || location.href, title: item.title },
      smallIcon: "ic_stat_icon",
      iconColor: "#111827",
      actionTypeId: "",
      group: "anime-countdown",
      groupSummary: false
    });
  }

  if (toSchedule.length) {
    await LocalNotifications.schedule({ notifications: toSchedule });
  }
  return toSchedule.length;
}

async function cancelStaleNativeNotifications() {
  if (!isCapacitor()) return;
  const LocalNotifications = getLocalNotifications();
  if (!LocalNotifications) return;
  const pending = await LocalNotifications.getPending();
  const validIds = new Set();
  const now = Date.now();
  const favorites = state.releases.filter((item) => item.favorite);
  for (const item of favorites) {
    if (!policy.hasConfirmedTime(item)) continue;
    const releaseAt = new Date(item.releaseDate).getTime();
    if (Number.isFinite(releaseAt) && releaseAt > now) {
      validIds.add(hashNotificationId(item));
    }
  }
  const toCancel = pending.notifications.filter((n) => !validIds.has(n.id));
  if (toCancel.length) {
    await LocalNotifications.cancel({ notifications: toCancel });
  }
}

async function downloadCoverImage(url, notifId) {
  try {
    if (!isCapacitor()) return null;
    if (!Capacitor.Plugins || !Capacitor.Plugins.Filesystem) return null;
    const Filesystem = Capacitor.Plugins.Filesystem;
    const path = "cover-" + notifId + ".jpg";

    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var base64 = null;

        // When CapacitorHttp interception is active, fetch().blob() receives the
        // response through the native bridge as a string, corrupting binary data.
        // Use CapacitorHttp.request() with responseType:'blob' instead — it returns
        // the image as a proper base64 string ready to write to disk.
        var CapHttp = Capacitor.Plugins.CapacitorHttp;
        if (CapHttp) {
          var nativeResp = await CapHttp.request({ url: url, method: "GET", responseType: "blob" });
          if (!nativeResp || nativeResp.status < 200 || nativeResp.status >= 300) {
            if (nativeResp && nativeResp.status === 429 && attempt < 2) {
              await new Promise(function (r) { setTimeout(r, 1000 * (attempt + 1)); });
              continue;
            }
            return null;
          }
          base64 = nativeResp.data;
        } else {
          var response = await fetch(url);
          if (!response.ok) {
            if (response.status === 429 && attempt < 2) {
              await new Promise(function (r) { setTimeout(r, 1000 * (attempt + 1)); });
              continue;
            }
            return null;
          }
          var blob = await response.blob();
          base64 = await new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onloadend = function () {
              var dataUrl = reader.result;
              var idx = dataUrl.indexOf(",");
              resolve(idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl);
            };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsDataURL(blob);
          });
        }

        var result = await Filesystem.writeFile({ path: path, data: base64, directory: "DATA", recursive: true });
        return result.uri;
      } catch (e) {
        if (attempt < 2) {
          await new Promise(function (r) { setTimeout(r, 1000 * (attempt + 1)); });
        }
      }
    }
    return null;
  } catch (error) {
    console.warn("Error al descargar portada:", error);
    return null;
  }
}

function hashNotificationId(item) {
  const key = `${item.id || getEpisodeKey(item)}|${item.releaseDate || "no-date"}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.max(1, Math.abs(hash) % 2147483647);
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

function getReleaseTimingLabel(item) {
  if (item.scheduleStatus === "unscheduled") return `Emisión en Japón: ${formatDate(item.anilistAiringDate)}`;
  if (item.scheduleStatus === "conflict") return "Reprogramación pendiente de confirmar";
  if (item.scheduleStatus === "date-confirmed") return "Hora SUB por confirmar";
  if (policy.isPending(item)) return "Retrasado · fecha por confirmar";
  return getCountdown(item.releaseDate).text;
}

function renderOfficialEvidence(item) {
  const entry = (item.officialEvidence || []).find(source => /^https:\/\//.test(source.url || ""));
  if (!entry) return "";
  return `<a class="official-evidence" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Anuncio oficial</a>`;
}

function renderScheduleHealth() {
  const box = $("scheduleHealth");
  const label = $("scheduleHealthText");
  if (!box || !label) return;
  const health = state.scheduleHealth;
  box.classList.toggle("hidden", !health.loading && !health.error && !health.stale && !health.bundled);
  const updated = health.updatedAt && Number.isFinite(Date.parse(health.updatedAt))
    ? ` Datos: ${new Intl.DateTimeFormat("es-ES", { timeZone: getSelectedTimezone(), dateStyle: "medium", timeStyle: "short" }).format(new Date(health.updatedAt))}.` : "";
  label.textContent = (health.loading ? "Cargando horarios…" : health.error ? `${health.error} Se conserva la copia local.` :
    health.stale ? "Horario desactualizado: no contiene próximas emisiones SUB confirmadas." :
    health.bundled ? "Sin conexión: usando el horario incluido en la app." : "") + updated;
  box.dataset.warning = String(Boolean(health.error || health.stale || health.bundled));
  const button = $("retryScheduleBtn");
  if (button) button.disabled = Boolean(health.loading);
}

function scheduleRender(delay = 80) {
  const generation = ++renderGeneration;
  setTimeout(() => {
    if (generation === renderGeneration) render();
  }, delay);
}

function render() {
  renderLinkOptions();
  renderGeneration++;
  if (renderRemainingTimer) {
    clearTimeout(renderRemainingTimer);
    renderRemainingTimer = null;
  }
  cleanupVirtualListObserver();
  setActiveTab();
  renderScheduleHealth();
  renderAnilistSyncStatus();
  renderNextModern();
  renderListModern();
  const focusedChip = document.activeElement?.closest("#settingsPanel .platform-chip");
  const focusAttribute = focusedChip?.hasAttribute("data-platform") ? "data-platform" : "data-filter";
  const focusValue = focusedChip?.getAttribute(focusAttribute);
  renderSettingsPlatformFilter();
  renderContentFilter();
  if (focusedChip) {
    [...els.settingsPanel.querySelectorAll(".platform-chip")]
      .find(chip => chip.getAttribute(focusAttribute) === focusValue)?.focus({ preventScroll: true });
  }
}
function updateLiveCountdowns() {
  if (state.currentNext) {
    const c = getCountdown(state.currentNext.releaseDate);
    const nextCountdown = els.nextRelease.querySelector(".next-countdown");
    if (nextCountdown) nextCountdown.textContent = c.text;
    if (c.expired) {
      invalidateDataCaches();
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
    if (item && countdown) countdown.textContent = getReleaseTimingLabel(item);
  });
}

function scheduleMidnightRefresh() {
  clearTimeout(midnightRefreshTimer);
  try {
    const tz = getSelectedTimezone();
    const now = new Date();
    const day = getDateKeyInZone(now, tz);
    const tomorrow = new Date(`${day}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const localMidnight = `${tomorrow.toISOString().slice(0, 10)}T00:00:00`;
    const msUntilMidnight = Math.max(1000, Date.parse(zonedLocalIsoToUtcIso(localMidnight, tz)) - now.getTime());
    midnightRefreshTimer = setTimeout(() => {
      invalidateDataCaches();
      render();
      scheduleMidnightRefresh();
    }, msUntilMidnight);
  } catch (e) {
    midnightRefreshTimer = setTimeout(scheduleMidnightRefresh, 3600000);
  }
}
function setActiveTab() { els.showAllBtn.classList.toggle("active", state.viewMode==="all"); els.showTodayBtn.classList.toggle("active", state.viewMode==="today"); els.showFavsBtn.classList.toggle("active", state.viewMode==="favorites"); const modes=["all","today","favorites"]; const idx=modes.indexOf(state.viewMode); const ind=document.querySelector(".tab-indicator"); if(ind){ind.style.transition="transform 280ms var(--ease)";ind.style.transform=`translateX(calc(${idx*100}% + ${idx*8}px))`;} }
function adjustDelayedDates(items) { return items; }
function getPendingItems(items) { return items.filter(item => policy.isPending(item) && isSchedulableItem(item)); }

function getVisibleItems() {
  const dayKey = getDateKeyInZone(new Date(), getSelectedTimezone());
  const contentKey = state.hiddenContent.join("|");
  return memoList(`visible|${state.viewMode}|${dayKey}|${contentKey}`, () => {
    if(state.viewMode==="favorites") return getOneNextPerSeries(getFavoriteItems()).concat(getPendingItems(getFavoriteItems()), getUnscheduledLibraryItems());
    if(state.viewMode==="today") return getTodayItems(adjustDelayedDates(getFavoriteItems()));
    const catalog = getCatalogItems();
    return getOneNextPerSeries(catalog).concat(getPendingItems(catalog));
  });
}
function getKnownServices(item) {
  return [...new Set([item.service, ...(item.allServices || [])].map(subscriptionService).filter(Boolean))];
}
function getMarkedService(item) {
  const available = getKnownServices(item).filter(service => !state.hiddenPlatforms.includes(service));
  const primary = subscriptionService(item.service);
  return available.includes(primary) ? primary : available.sort((a, b) => SERVICE_PRIORITY[a] - SERVICE_PRIORITY[b])[0] || "No legal platform";
}
function getDisplayService(item) { return getActiveWatchSource(item)?.service || "No legal platform"; }
function getFavoriteItems() { return memoList("favorites", () => mergeDuplicateItems(state.releases.filter(item => item.favorite))); }
function getUnscheduledLibraryItems({ includeFiltered = false } = {}) {
  return state.anilistLibrary.filter(item => item.favorite !== false && (includeFiltered || isSchedulableItem(item))
    && Date.parse(item.anilistAiringDate || "") > Date.now()
    && !state.releases.some(release => getSeriesKey(release) === getSeriesKey(item) || getSeriesMatchScore(release, item) >= 0.78))
    .map(item => ({ ...item, releaseDate: null, delayed: false, scheduleStatus: "unscheduled", favorite: true }));
}
function getCatalogItems() { return memoList("catalog", () => mergeDuplicateItems(state.releases)); }
function getOneNextPerSeries(items) {
  const memoKey = items?.__memoKey;
  if (memoKey) return memoList(`oneNext|${memoKey}`, () => buildOneNextPerSeries(items));
  return buildOneNextPerSeries(items);
}
function buildOneNextPerSeries(items) { const now = new Date(); const groups = new Map(); for(const item of mergeDuplicateItems(items).filter(item => isSchedulableItem(item) && policy.hasConfirmedTime(item))) { if(!item.releaseDate) continue; const d = new Date(item.releaseDate); if(Number.isNaN(d.getTime()) || d <= now) continue; const key=getSeriesKey(item); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(item); } const result=[]; for(const eps of groups.values()) { const ordered=sortByDate(eps); if(ordered.length) result.push(ordered[0]); } return sortByDate(result); }
function getTodayItems(items) {
  const memoKey = items?.__memoKey;
  if (memoKey) return memoList(`today|${memoKey}|${getDateKeyInZone(new Date(), getSelectedTimezone())}`, () => sortByDate(mergeDuplicateItems(items).filter(item => isSchedulableItem(item) && isToday(item.releaseDate))));
  return sortByDate(mergeDuplicateItems(items).filter(item => isSchedulableItem(item) && isToday(item.releaseDate)));
}
function getOneTodayPerSeries(items) { const groups = new Map(); for(const item of mergeDuplicateItems(items)) { if(!item.releaseDate) continue; const d = new Date(item.releaseDate); if(Number.isNaN(d.getTime())) continue; const key=getSeriesKey(item); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(item); } const result=[]; for(const eps of groups.values()) { const ordered=sortByDate(eps); if(ordered.length) result.push(ordered[0]); } return sortByDate(result); }
function getRemainingTodayItems(items) { const now = new Date(); return getOneNextPerSeries(items.filter(item => isSchedulableItem(item) && isToday(item.releaseDate) && new Date(item.releaseDate) > now)); }

function renderCover(item, cls) { const letter=escapeHtml(String(item.title||"?").trim().charAt(0).toUpperCase() || "?"); if(!item.coverUrl) return `<div class="${cls} placeholder">${letter}</div>`; const priority=cls.includes("next-cover")?'loading="eager" fetchpriority="high"':'loading="lazy" fetchpriority="low"'; return `<img class="${cls}" src="${escapeHtml(item.coverUrl)}" alt="${escapeHtml(item.title)}" ${priority} decoding="async" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;${cls} placeholder&quot;>${letter}</div>'"/>`; }
function renderPreview(items) { if(!els.importPreview) return; const shown=getOneNextPerSeries(items); els.importPreview.innerHTML=""; shown.slice(0,6).forEach(item => { const card=document.createElement("div"); card.className="result-card"; card.innerHTML=`<div class="result-title">${escapeHtml(item.title)}</div><div class="result-meta">${escapeHtml(item.episode)} · ${escapeHtml(serviceLabel(getDisplayService(item)))}<br/>${escapeHtml(formatDate(item.releaseDate))}</div>`; els.importPreview.appendChild(card); }); if(shown.length>6) { const more=document.createElement("div"); more.className="empty-message"; more.textContent=`Y ${shown.length-6} más...`; els.importPreview.appendChild(more); } }

function getCountdown(dateValue) { if (!dateValue) return { text:"Fecha por confirmar", expired:false }; const target=new Date(dateValue), now=new Date(), diff=target-now; if(Number.isNaN(target.getTime())) return { text:"Fecha inválida", expired:true }; if(diff<=0) return { text:"Ya disponible", expired:true }; const s=Math.floor(diff/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60; return { text:`${d}d ${h}h ${m}min ${sec}s`, expired:false }; }
function formatDate(value) { if (!value) return "Sin fecha confirmada"; const d=new Date(value); if(Number.isNaN(d.getTime())) return "Sin fecha"; return new Intl.DateTimeFormat("es-ES",{timeZone: getSelectedTimezone(),weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false}).format(d); }
function isToday(value) { if (!value) return false; const d=new Date(value); if(Number.isNaN(d.getTime())) return false; return getDateKeyInZone(d, getSelectedTimezone()) === getDateKeyInZone(new Date(), getSelectedTimezone()); }
function getDeviceTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      new Intl.DateTimeFormat("es", { timeZone: timezone });
      return timezone;
    }
  } catch {}
  return "Europe/Madrid";
}
function getSelectedTimezone() { return state.timezone; }
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
function sortRelevantByDate(items) { const now = Date.now(); return [...items].sort((a,b)=>{ const at=Date.parse(a.releaseDate||""), bt=Date.parse(b.releaseDate||""); const af=Number.isFinite(at)&&at>now, bf=Number.isFinite(bt)&&bt>now; if(af!==bf) return af ? -1 : 1; if(af) return at-bt; return bt-at; }); }
function getEpisodeKey(item) { const ep=item.episodeNumber || String(item.episode||"").replace(/[^0-9]/g,""); const time=Date.parse(item.releaseDate || ""); const date=Number.isFinite(time) ? new Date(time).toISOString().slice(0,10) : "no-date"; return `${getSeriesKey(item)}|${ep}|${date}`; }
function isSchedulableItem(item) {
  if (item.excludeFromSchedule || item.scheduleStatus === "cancelled") return false;
  if (state.hiddenContent.includes("adult") && (item.isAdult || hasAdultAnilistTag(item))) return false;
  const format = String(item.anilistFormat || item.format || "").toUpperCase();
  if (state.hiddenContent.includes("ova") && format === "OVA") return false;
  if (state.hiddenContent.includes("ona") && format === "ONA") return false;
  if (state.hiddenContent.includes("movie") && format === "MOVIE") return false;
  if (state.hiddenContent.includes("special") && format === "SPECIAL") return false;
  if (state.hiddenContent.includes("music") && format === "MUSIC") return false;
  if (state.hiddenContent.includes("kodomo") && hasKodomoSignal(item)) return false;
  return true;
}

function isSeasonalSeriesItem(item) {
  const format = String(item.anilistFormat || item.format || "").toUpperCase();
  const releaseAt = Date.parse(item.releaseDate || "");
  return ["TV", "TV_SHORT", "ONA"].includes(format)
    && Number.isFinite(releaseAt)
    && releaseAt > Date.now();
}

function hasKodomoSignal(item) {
  const textFields = [item.title, item.anilistTitle, item.animeKey, item.route];
  if (textFields.some(value => /\bkodomo\b/i.test(String(value || "")))) return true;
  const names = [...(item.genres || []), ...(item.tags || [])];
  return names.some(value => /^(kids|kodomo|children|preschool)$/i.test(String(value?.name || value || "")));
}
function hasAdultAnilistTag(item) {
  const blockedGenres = ["hentai", "erotica"];
  const genres = Array.isArray(item.genres) ? item.genres : [];
  return genres.some(genre => blockedGenres.includes(String(genre || "").toLowerCase()));
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
  if (a.anilistId && b.anilistId) {
    return String(a.anilistId) === String(b.anilistId) ? 1 : 0;
  }
  const aTitles = [a.title, a.anilistTitle, a.route, a.animeKey, ...(a.titles || [])].filter(Boolean);
  const bTitles = [b.title, b.anilistTitle, b.route, b.animeKey, ...(b.titles || [])].filter(Boolean);
  let best = 0;
  for (const left of aTitles) for (const right of bTitles) best = Math.max(best, titleSimilarityScore(left, right));
  return best;
}
function getAnimeKey(item) { return stableId(item.animeKey || item.route || item.title); }
function getSeriesKey(item) { return stableId(item.anilistId || item.anilistTitle || item.animeKey || item.route || normalizeTitle(item.title)); }
function stableId(...parts) { return parts.filter(Boolean).join("-").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\p{L}\p{N}]+/gu,"-").replace(/(^-|-$)/g,""); }
function normalizeTitle(value) { return String(value||"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/\([^)]*\)/g,"").replace(/\[[^\]]*\]/g,"").replace(/&/g,"and").replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g,"season $1").replace(/\bseason\s*(\d+)\b/g,"$1").replace(/\bs(\d+)\b/g,"$1").replace(/\bpart\s*\d+\b/g,"").replace(/\bcour\s*\d+\b/g,"").replace(/\bthe\b/g,"").replace(/\ba\b/g,"").replace(/\ban\b/g,"").replace(/[^\p{L}\p{N}]+/gu,""); }
function normalizeUrl(url) { const v=String(url||"").trim(); if(!v)return ""; if(v.startsWith("http://")||v.startsWith("https://"))return v; if(v.startsWith("//"))return `https:${v}`; if(v.includes("."))return `https://${v}`; return ""; }
function getActiveCustomUrl(item) {
  const service = subscriptionService(item.customPlatformName);
  return service && state.hiddenPlatforms.includes(service) ? "" : normalizeUrl(item.customUrl);
}
function getPlatformWatchUrl(item, service) {
  const record = item.platformsByCountry?.[state.jwCountry];
  const offer = record?.status === "verified" ? record.offers?.find(offer => subscriptionService(offer.service) === service) : null;
  const offerUrl = normalizeUrl(offer?.url);
  if (offerUrl) return offerUrl;
  const regionalUrl = Object.entries(item.serviceUrls || {}).find(([name]) => subscriptionService(name) === service)?.[1];
  if (normalizeUrl(regionalUrl)) return normalizeUrl(regionalUrl);
  if (service === subscriptionService(item.service) && normalizeUrl(item.serviceUrl)) return normalizeUrl(item.serviceUrl);
  return defaultServiceUrl(service);
}
function getWatchSources(item) {
  const sources = getKnownServices(item).sort((a, b) => SERVICE_PRIORITY[a] - SERVICE_PRIORITY[b])
    .map(service => ({ id: `platform:${service}`, kind: "platform", label: service, buttonLabel: `Ver en ${service}`, service, url: getPlatformWatchUrl(item, service) }));
  const personal = getPersonalSearchUrl(item);
  const name = cleanPersonalLinkName(state.personalLinkName);
  if (personal) sources.push({ id: "personal", kind: "personal", label: name || "Enlace personal", buttonLabel: name ? `Ver en ${name}` : "Buscar", url: personal });
  const custom = normalizeUrl(item.customUrl);
  if (custom) sources.push({ id: "custom", kind: "custom", label: item.customPlatformName?.trim() || "link asociado", buttonLabel: `Ver en ${item.customPlatformName?.trim() || "link asociado"}`, url: custom });
  return sources;
}
function getAutomaticWatchSource(item, sources = getWatchSources(item)) {
  if (getActiveCustomUrl(item)) return sources.find(source => source.id === "custom");
  return sources.find(source => source.service === getMarkedService(item)) || sources.find(source => source.id === "personal") || null;
}
function getActiveWatchSource(item) {
  const sources = getWatchSources(item);
  return sources.find(source => source.id === getUserOverride(item)?.activeLink) || getAutomaticWatchSource(item, sources);
}
function getSecondaryWatchSource(item, active = getActiveWatchSource(item)) {
  if (active?.kind === "platform" || active?.id === "personal") return null;
  return getWatchSources(item).find(source => source.id === "personal") || null;
}
function getBestWatchUrl(item) { return getActiveWatchSource(item)?.url || ""; }
function defaultServiceUrl(service) {
  return {
    "Crunchyroll": "https://www.crunchyroll.com/",
    "Prime Video": "https://www.primevideo.com/",
    "Disney+": "https://www.disneyplus.com/",
    "Netflix": "https://www.netflix.com/"
  }[service] || "";
}
function escapeHtml(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }

async function saveReleases() { invalidateDataCaches(); await browserApi.storage.local.set({ releases: state.releases }); }
async function saveAllLists() { invalidateDataCaches(); await browserApi.storage.local.set({ releases: state.releases, anilistLibrary: state.anilistLibrary, userOverrides: state.userOverrides, customPlatforms: state.customPlatforms, customLinks: state.customLinks }); }
function showStatus(message,type="") { els.statusBox.textContent=message; els.statusBox.className=`status-box ${type}`; setTimeout(()=>{ els.statusBox.className="status-box hidden"; },6000); }
function showFatal(error) { document.body.innerHTML=`<main style="padding:16px;font-family:Arial;background:#0f172a;color:white;min-height:650px"><h1>Error cargando extensión</h1><pre style="white-space:pre-wrap;color:#fecaca;background:#450a0a;border:1px solid #991b1b;border-radius:12px;padding:10px">${escapeHtml(error?.stack||error?.message||String(error))}</pre></main>`; }
function getEmptyViewMessage() {
  if (state.searchQuery) return "No hay coincidencias para esta búsqueda.";
  if (state.viewMode !== "all" && !getFavoriteItems().length && !state.anilistLibrary.some(item => item.favorite !== false))
    return "Aún no tienes favoritos. Añádelos desde Todos o sincroniza AniList.";
  const source = state.viewMode === "favorites"
    ? state.releases.concat(getUnscheduledLibraryItems({ includeFiltered: true }))
    : state.releases;
  const candidates = source.filter(item => (state.viewMode === "all" || item.favorite)
    && (state.viewMode === "today" ? isToday(item.releaseDate) : (new Date(item.releaseDate) > new Date() || policy.isPending(item) || (state.viewMode === "favorites" && item.scheduleStatus === "unscheduled"))));
  if (candidates.some(item => !isSchedulableItem(item)))
    return "No hay episodios en esta vista. Comprueba tus filtros o consulta Todos.";
  return state.viewMode === "today" ? "Hoy no hay estrenos de tus favoritos." : "No hay próximos episodios para mostrar.";
}

function renderNextModern() {
  let items = getNextHighlightItems();
  const todayEmpty = state.viewMode === "today" && !getFilteredVisibleItems().length;
  const emptyMessage = getEmptyViewMessage();
  let nextFavorite = false;
  if (state.viewMode === "today" && !items.length && todayEmpty && !state.searchQuery && !emptyMessage.includes("filtros")) {
    items = getOneNextPerSeries(getFavoriteItems());
    nextFavorite = items.length > 0;
  }
  if (!items.length || (todayEmpty && state.searchQuery)) {
    state.currentNext = null;
    els.nextRelease.className = "next-release empty";
    if (state.scheduleHealth.loading || state.scheduleHealth.error || state.scheduleHealth.stale) {
      els.nextRelease.textContent = state.scheduleHealth.loading ? "Cargando horarios…" : state.scheduleHealth.error ? "No se pudo actualizar el horario" : "Horario desactualizado";
      return;
    }
    const hasTodayList = state.viewMode === "today" && !todayEmpty;
    els.nextRelease.innerHTML = `<div class="next-content"><div class="next-label">${hasTodayList ? "¡Fin del día!" : "Sin estrenos"}</div><div class="next-title">${hasTodayList ? "Hoy no sale nada más" : "No hay próximos episodios"}</div><div class="next-episode">${escapeHtml(hasTodayList ? "Revisa abajo los estrenos de hoy." : emptyMessage)}</div></div>`;
    return;
  }

  const item = items[0];
  state.currentNext = item;
  const c = getCountdown(item.releaseDate);
  const scorePill = getAnilistScorePill(item);
  const premierePill = getPremierePill(item);
  const delayedPill = getDelayedPill(item);
  els.nextRelease.className = "next-release";
  els.nextRelease.innerHTML = `<div class="cover-stack next-cover-stack">${renderCover(item, "next-cover")}${scorePill}</div><div class="next-content"><div class="next-label${nextFavorite ? " next-favorite-label" : ""}">${nextFavorite ? "Próximo favorito" : "Próximo episodio"}</div><div class="next-title">${escapeHtml(item.title)}</div><div class="next-episode">${escapeHtml(item.episode)} · ${escapeHtml(serviceLabel(getDisplayService(item)))}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div><div class="next-countdown">${escapeHtml(c.text)}</div><div class="next-meta">${escapeHtml(formatDate(item.releaseDate))}${premierePill}${delayedPill}</div></div>`;
}

function getNextHighlightItems() {
  const dayKey = getDateKeyInZone(new Date(), getSelectedTimezone());
  const contentKey = state.hiddenContent.join("|");
  return memoList(`highlight|${state.viewMode}|${dayKey}|${contentKey}`, () => {
    if (state.viewMode === "all") return getOneNextPerSeries(adjustDelayedDates(getCatalogItems()));
    if (state.viewMode === "today") return getRemainingTodayItems(adjustDelayedDates(getFavoriteItems()));
    return getOneNextPerSeries(adjustDelayedDates(getFavoriteItems()));
  });
}

function renderListModern() {
  const generation = renderGeneration;
  var visible = getFilteredVisibleItems();
  var title = state.viewMode==="today"?"Estrenos de hoy":state.viewMode==="favorites"?"Favoritos":"Proximos estrenos";
  var listTitle = document.getElementById("listTitle");
  if (listTitle) listTitle.textContent = title + " · " + visible.length;

  cleanupVirtualListObserver();
  virtualListItems = visible;
  virtualListRendered = 0;
  els.animeList.innerHTML = "";

  if (!visible.length) {
    var empty = document.createElement("div");
    empty.className = "empty-message";
    empty.textContent = state.scheduleHealth.loading ? "Cargando horarios…" :
      state.scheduleHealth.error ? "No se ha podido actualizar el horario. Reintenta arriba." :
      state.scheduleHealth.stale ? "El horario disponible está desactualizado. Estamos pendientes de nuevos datos." :
      getEmptyViewMessage();
    els.animeList.appendChild(empty);
    return;
  }

  renderVirtualListBatch(generation);
}

function getFilteredVisibleItems() {
  var visible = getVisibleItems();
  if (state.searchQuery) {
    const normalizeSearch = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const q = normalizeSearch(state.searchQuery);
    visible = visible.filter(item => [item.title, ...(item.titles || []), item.anilistTitle, item.episode, getDisplayService(item)]
      .some(value => normalizeSearch(value).includes(q)));
  }
  const scheduled = visible.filter(item => !policy.isPending(item) && item.scheduleStatus !== "unscheduled");
  const pending = visible.filter(item => policy.isPending(item));
  const unscheduled = visible.filter(item => item.scheduleStatus === "unscheduled");
  if (!state.sortAsc) { scheduled.reverse(); pending.reverse(); unscheduled.reverse(); }
  return scheduled.concat(pending, unscheduled);
}

function cleanupVirtualListObserver() {
  if (virtualListObserver) {
    virtualListObserver.disconnect();
    virtualListObserver = null;
  }
}

function renderVirtualListBatch(generation = renderGeneration) {
  if (generation !== renderGeneration) return;
  cleanupVirtualListObserver();
  const oldSentinel = els.animeList.querySelector(".virtual-list-sentinel");
  if (oldSentinel) oldSentinel.remove();

  const start = virtualListRendered;
  const end = Math.min(start + VIRTUAL_LIST_BATCH_SIZE, virtualListItems.length);
  var frag = document.createDocumentFragment();
  for (var i = start; i < end; i++) {
    if (generation !== renderGeneration) return;
    if (policy.isPending(virtualListItems[i]) && (i === 0 || !policy.isPending(virtualListItems[i - 1]))) {
      const heading = document.createElement("h2");
      heading.className = "pending-heading";
      heading.textContent = "Retrasos pendientes de confirmación";
      frag.appendChild(heading);
    }
    if (virtualListItems[i].scheduleStatus === "unscheduled" && (i === 0 || virtualListItems[i - 1].scheduleStatus !== "unscheduled")) {
      const heading = document.createElement("h2");
      heading.className = "pending-heading";
      heading.textContent = "Sin horario de subtítulos";
      frag.appendChild(heading);
    }
    frag.appendChild(createCardModern(virtualListItems[i]));
  }
  els.animeList.appendChild(frag);
  virtualListRendered = end;

  if (virtualListRendered < virtualListItems.length) {
    appendVirtualListSentinel(generation);
  }
}

function appendVirtualListSentinel(generation) {
  const sentinel = document.createElement("div");
  sentinel.className = "virtual-list-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  els.animeList.appendChild(sentinel);

  if ("IntersectionObserver" in window) {
    virtualListObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        renderVirtualListBatch(generation);
      }
    }, { rootMargin: "650px 0px" });
    virtualListObserver.observe(sentinel);
    return;
  }

  renderRemainingTimer = setTimeout(() => renderVirtualListBatch(generation), 120);
}

function createCardModern(item) {
  const unscheduled = item.scheduleStatus === "unscheduled";
  const c = { text: getReleaseTimingLabel(item) };
  const activeSource = getActiveWatchSource(item);
  const watchButton = activeSource
    ? `<button class="small-btn primary-link" type="button" data-action="open" data-id="${escapeHtml(item.id)}">${escapeHtml(activeSource.buttonLabel)}</button>` : "";
  const delayedBadge = getDelayedBadge(item);
  const premiereBadge = getPremiereBadge(item);
  const scorePill = getAnilistScorePill(item);
  const customButton = activeSource?.kind === "custom"
    ? `<button class="small-btn" type="button" data-action="removeCustomLink" data-key="${escapeHtml(getAnimeKey(item))}">Quitar link</button>`
    : `<button class="small-btn" type="button" data-action="customLink" data-key="${escapeHtml(getAnimeKey(item))}">Asociar link</button>`;
  const card = document.createElement("article");
  card.className = "anime-card";
  card.dataset.id = item.id;
  card.dataset.key = getAnimeKey(item);
  card.setAttribute("aria-haspopup", "dialog");
  card.dataset.action = "open";
  card.tabIndex = 0;
  card.setAttribute("aria-label", `${item.title}, ${item.episode}, ${getReleaseTimingLabel(item)}`);
  card.addEventListener("keydown", event => {
    if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openOrAsk(item); }
  });
  const fallbackSource = { anilist: "AniList", animeschedule: "AnimeSchedule" }[item.platformSource];
  const unverifiedBadge = fallbackSource && activeSource?.kind === "platform" ? `<span class="badge badge-unverified" title="Enlace de ${fallbackSource} sin confirmar: puede que no esté en ninguna plataforma en España">Puede no estar disponible</span>` : "";
  const badgeLabel = activeSource?.label || "Sin plataforma";
  const secondarySource = getSecondaryWatchSource(item, activeSource);
  const secondaryButton = secondarySource
    ? `<button class="small-btn" type="button" data-action="secondary" data-id="${escapeHtml(item.id)}">${escapeHtml(secondarySource.label)}</button>` : "";
  card.innerHTML = `<div class="cover-stack">${renderCover(item, "cover")}${scorePill}</div><div class="card-main"><div class="card-top"><div class="card-heading"><div class="anime-title">${escapeHtml(item.title)}</div><div class="anime-episode">${escapeHtml(item.episode)} · ${escapeHtml(serviceLabel(getDisplayService(item)))}${isToday(item.releaseDate) ? '<span class="today-pill">HOY</span>' : ""}</div></div><button class="favorite-btn ${item.favorite ? 'favorite' : 'add'}" type="button" aria-label="${item.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}" data-action="favorite" data-key="${escapeHtml(getAnimeKey(item))}">${item.favorite ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>` : "+"}</button></div>${unscheduled ? "" : `<div class="countdown">${escapeHtml(c.text)}</div>`}<div class="meta">${escapeHtml(unscheduled ? getReleaseTimingLabel(item) : item.confirmedSubDate && item.scheduleStatus === "date-confirmed" ? `Fecha SUB: ${item.confirmedSubDate}` : formatDate(item.releaseDate))}${renderOfficialEvidence(item)}</div><div class="badges"><span class="badge badge-purple">${escapeHtml(badgeLabel)}</span>${unverifiedBadge}${premiereBadge}${delayedBadge}</div><div class="card-actions${secondaryButton && watchButton ? " has-secondary" : ""}">${watchButton}${secondaryButton}${customButton}</div></div>`;
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
