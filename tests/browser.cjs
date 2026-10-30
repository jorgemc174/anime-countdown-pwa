"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const { chromium } = require("playwright");
process.env.PORT = "0";
const server = require("../server");
const now = "2026-10-30T12:00:00Z";
const baseRow = { id: "sample-4", animeKey: "sample", title: "Sample", episode: "Ep 4", episodeNumber: "4", airType: "SUB", releaseDate: "2026-10-30T18:00:00Z", service: "Crunchyroll", serviceUrl: "https://www.crunchyroll.com/", hasAllowedPlatform: true };
const pending = { ...baseRow, id: "delayed-7", animeKey: "delayed", title: "Delayed", episode: "Ep 7", episodeNumber: "7", releaseDate: null, scheduleStatus: "pending", delayed: true };
const payload = { source: "AnimeSchedule", updatedAt: now, checkedAt: now, releases: [baseRow, pending] };

(async () => {
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  let passed = 0;
  async function ready(page) {
    await page.waitForFunction(() => sharedRefreshPromise === null && !state.scheduleHealth.loading);
    await page.waitForFunction(() => !document.getElementById("animeList").textContent.includes("Cargando"));
  }
  async function scenario(name, fn) {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, timezoneId: "Europe/Madrid", reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
    await page.clock.install({ time: new Date(now) });
    await page.route("https://**/*", route => route.abort());
    await page.route("**/schedule.json", route => route.fulfill({ json: payload }));
    try { await fn(page, context); passed++; console.log("PASS", name); }
    finally { await context.close(); }
  }
  try {
    await scenario("first visit explains favorites; All includes undated delays", async page => {
      await page.goto(base);
      await ready(page);
      assert.match(await page.locator("#animeList").innerText(), /Aún no tienes favoritos/);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 2);
      assert.match(await page.locator("#animeList").innerText(), /Retrasado · fecha por confirmar/);
      assert.equal(await page.locator(".pending-heading").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('.anime-card[data-id="sample-4"] [data-action="favorite"]').click();
      await page.locator("#showTodayBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 1);
      await page.reload();
      await ready(page);
      assert.equal(await page.locator(".anime-card").count(), 1);
    });
    await scenario("stale production data is explicitly diagnosed", async page => {
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, updatedAt: "2026-07-22T12:00:00Z", releases: [{ ...baseRow, releaseDate: "2026-09-10T12:00:00Z" }] } }));
      await page.goto(base);
      await ready(page);
      assert.match(await page.locator("#scheduleHealth").innerText(), /desactualizado/);
      assert.doesNotMatch(await page.locator("#nextRelease").innerText(), /Fin del día/);
    });
    await scenario("malformed updates preserve favorites and confirmed local releases", async page => {
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      await page.locator('.anime-card[data-id="sample-4"] [data-action="favorite"]').click();
      await page.route("**/schedule.json", route => route.fulfill({ json: { releases: [{ title: "Broken", releaseDate: "invalid" }] } }));
      await page.evaluate(() => refreshSharedSchedule({ force: true }));
      await page.waitForFunction(() => Boolean(state.scheduleHealth.error));
      assert.equal(await page.evaluate(() => state.releases.find(row => row.id === "sample-4").favorite), true);
      assert.equal(await page.locator(".anime-card").count(), 2);
    });
    await scenario("network failures recover on retry", async page => {
      await page.route("**/schedule.json", route => route.abort());
      await page.goto(base);
      await page.waitForFunction(() => Boolean(state.scheduleHealth.error));
      assert.match(await page.locator("#scheduleHealth").innerText(), /copia local/);
      await page.route("**/schedule.json", route => route.fulfill({ json: payload }));
      await page.locator("#retryScheduleBtn").click();
      await page.waitForFunction(() => !state.scheduleHealth.error && !state.scheduleHealth.loading);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 2);
    });
    await scenario("date-only delays never enter Today or notification candidates", async page => {
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [{ ...pending, scheduleStatus: "date-confirmed", confirmedSubDate: "2026-10-30" }] } }));
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      assert.match(await page.locator("#animeList").innerText(), /Hora SUB por confirmar/);
      assert.match(await page.locator("#animeList").innerText(), /2026-10-30/);
      assert.deepEqual(await page.evaluate(() => getDueNotificationItems(state.releases, Date.parse("2026-10-30T12:00:00Z"))), []);
      await page.locator('[data-action="favorite"]').click();
      await page.locator("#showTodayBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 0);
      await page.locator("#showFavsBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 1);
    });
    await scenario("Android reads the remote schedule and preserves preferences across updates", async page => {
      let remote = 0;
      await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, Plugins: {} }; });
      await page.route("https://anicountdown.com/schedule.json", route => { remote++; return route.fulfill({ json: payload }); });
      await page.goto(base);
      await ready(page);
      assert.equal(remote, 1);
      assert.equal(await page.evaluate(() => SHARED_SCHEDULE_URL), "https://anicountdown.com/schedule.json");
      await page.locator("#showAllBtn").click();
      await page.locator('.anime-card[data-id="sample-4"] [data-action="favorite"]').click();
      await page.route("https://anicountdown.com/schedule.json", route => route.fulfill({ json: { ...payload, releases: [{ ...baseRow, id: "sample-new-date", releaseDate: "2026-11-01T17:00:00Z" }] } }));
      await page.evaluate(() => refreshSharedSchedule({ force: true }));
      await page.waitForFunction(() => state.releases.some(row => row.id === "sample-new-date"));
      assert.equal(await page.evaluate(() => state.releases[0].favorite), true);
    });
    await scenario("corrupt stored arrays and timezone cannot block initialization", async page => {
      await page.addInitScript(() => localStorage.setItem("animeCountdownStorage", JSON.stringify({ releases: {}, anilistLibrary: {}, timezone: "not/a/timezone" })));
      await page.goto(base);
      await ready(page);
      assert.equal(await page.evaluate(() => state.timezone), "Europe/Madrid");
    });
    await scenario("storage denial does not block the app", async page => {
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage denied"); } });
        Object.defineProperty(window, "indexedDB", { get() { throw new Error("Storage denied"); } });
      });
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 2);
    });
    await scenario("concurrent storage writes preserve independent preferences", async page => {
      await page.goto(base);
      await ready(page);
      const saved = await page.evaluate(async () => {
        await Promise.all([
          browserApi.storage.local.set({ theme: "light", releases: state.releases }),
          browserApi.storage.local.set({ timezone: "Asia/Tokyo", userOverrides: state.userOverrides })
        ]);
        return browserApi.storage.local.get(["theme", "timezone"]);
      });
      assert.deepEqual(saved, { theme: "light", timezone: "Asia/Tokyo" });
    });
    await scenario("failed IndexedDB writes do not resurrect older favorites", async page => {
      await page.goto(base);
      await ready(page);
      await page.evaluate(async () => {
        setLargeStorageValues = async () => false;
        state.releases = state.releases.map(row => ({ ...row, favorite: true }));
        await saveAllLists();
      });
      await page.reload();
      await ready(page);
      assert.equal(await page.evaluate(() => state.releases.find(row => row.id === "sample-4").favorite), true);
    });
    await scenario("native rescheduling cancels the old notification; pending dates schedule none", async page => {
      await page.addInitScript(() => {
        window.nativeTest = { pending: [], cancelled: [], scheduled: [] };
        window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
          getPending: async () => ({ notifications: nativeTest.pending }),
          cancel: async value => { nativeTest.cancelled.push(...value.notifications); },
          schedule: async value => { nativeTest.scheduled.push(...value.notifications); }
        } } };
      });
      await page.goto(base);
      await ready(page);
      const result = await page.evaluate(async () => {
        const item = { ...state.releases[0], favorite: true };
        const oldId = hashNotificationId(item);
        item.releaseDate = "2026-10-31T19:00:00Z";
        state.releases = [item];
        state.notificationEnabled = true;
        nativeTest.pending = [{ id: oldId }];
        await cancelStaleNativeNotifications();
        await scheduleNativeNotifications();
        const newId = nativeTest.scheduled[0].id;
        state.releases = [{ ...item, scheduleStatus: "pending", releaseDate: null }];
        nativeTest.pending = [{ id: newId }];
        await cancelStaleNativeNotifications();
        const count = nativeTest.scheduled.length;
        await scheduleNativeNotifications();
        return { oldId, newId, cancelled: nativeTest.cancelled.map(row => row.id), count, finalCount: nativeTest.scheduled.length };
      });
      assert.notEqual(result.oldId, result.newId);
      assert.deepEqual(result.cancelled, [result.oldId, result.newId]);
      assert.equal(result.count, result.finalCount);
    });
    await scenario("shared platforms work before AniList sync and changing country never queries JustWatch", async page => {
      let requests = 0;
      page.on("request", request => { if (/justwatch/i.test(request.url())) requests++; });
      const regional = { ...baseRow, basePlatforms: { service: "Crunchyroll", serviceUrl: baseRow.serviceUrl, allServices: ["Crunchyroll"], hasAllowedPlatform: true }, platformsByCountry: {
        ES: { status: "verified", checkedAt: now, offers: [{ service: "Netflix", url: "https://www.netflix.com/title/shared", monetizationType: "FLATRATE" }] },
        MX: { status: "verified", checkedAt: now, offers: [{ service: "Prime Video", url: "https://www.primevideo.com/detail/shared", monetizationType: "FLATRATE" }] }
      } };
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [regional] } }));
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      assert.match(await page.locator("#animeList").innerText(), /Netflix/);
      assert.equal(await page.locator("#refreshDataBtn").count(), 0);
      await page.locator("#settingsBtn").click();
      await page.locator("#countryInput").selectOption("MX");
      await page.waitForFunction(() => state.releases[0].service === "Prime Video");
      assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), "https://www.primevideo.com/detail/shared");
      await page.clock.fastForward(60000);
      assert.equal(requests, 0);
      await page.reload();
      await ready(page);
      assert.equal(await page.evaluate(() => state.releases[0].service), "Prime Video");
    });
    await scenario("AniList sync changes only the personal library and keeps shared platforms, including delayed favorites", async page => {
      let scheduleRequests = 0, justwatchRequests = 0, anilistRequests = 0;
      const regional = { ...baseRow, anilistId: 42, service: "Netflix", serviceUrl: "https://www.netflix.com/title/shared", platformsByCountry: {
        ES: { status: "verified", checkedAt: now, offers: [{ service: "Netflix", url: "https://www.netflix.com/title/shared", monetizationType: "FLATRATE" }] }
      } };
      page.on("request", request => { if (/justwatch/i.test(request.url())) justwatchRequests++; });
      await page.route("**/schedule.json", route => { scheduleRequests++; return route.fulfill({ json: { ...payload, releases: [regional, { ...pending, anilistId: 84 }] } }); });
      await page.route("https://graphql.anilist.co", route => {
        anilistRequests++;
        assert.match(route.request().postDataJSON().query, /MediaListCollection/);
        return route.fulfill({ json: { data: { MediaListCollection: { lists: [{ entries: [
          { status: "CURRENT", media: { id: 42, status: "RELEASING", title: { romaji: "Sample", english: "Sample" }, nextAiringEpisode: { episode: 4, airingAt: 1793383200 }, externalLinks: [], streamingEpisodes: [] } },
          { status: "CURRENT", media: { id: 84, status: "RELEASING", title: { romaji: "Delayed", english: "Delayed" }, nextAiringEpisode: null, externalLinks: [], streamingEpisodes: [] } }
        ] }] } } } });
      });
      await page.goto(base);
      await ready(page);
      await page.locator("#settingsBtn").click();
      await page.locator("#anilistInput").fill("test-user");
      await page.locator("#syncAnilistBtn").click();
      await page.waitForFunction(() => state.lastAnilistSyncUsername === "test-user" && !els.syncAnilistBtn.disabled);
      assert.equal(scheduleRequests, 1);
      assert.equal(justwatchRequests, 0);
      assert.equal(anilistRequests, 1);
      assert.equal(await page.evaluate(() => state.releases.find(row => row.anilistId === 42).service), "Netflix");
      assert.equal(await page.evaluate(() => state.releases.find(row => row.anilistId === 84).favorite), true);
      assert.equal(await page.evaluate(() => state.releases.find(row => row.anilistId === 84).releaseDate), null);
      await page.route("**/schedule.json", route => { scheduleRequests++; return route.fulfill({ json: { ...payload, releases: [{ ...regional, platformsByCountry: { ES: { status: "verified", checkedAt: now, offers: [{ service: "HIDIVE", url: "https://www.hidive.com/shared", monetizationType: "FLATRATE" }] } } }, { ...pending, anilistId: 84 }] } }); });
      await page.clock.fastForward(15 * 60 * 1000 + 1000);
      await page.waitForFunction(() => state.releases.find(row => row.anilistId === 42)?.service === "HIDIVE");
      assert.equal(await page.evaluate(() => state.releases.find(row => row.anilistId === 42).favorite), true);
      assert.equal(justwatchRequests, 0);
    });
    await scenario("search and filters are usable with a keyboard", async page => {
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      await page.locator("#searchInput").fill("no matching series");
      assert.match(await page.locator("#animeList").innerText(), /No hay coincidencias/);
      await page.locator("#searchInput").fill("Sample");
      assert.equal(await page.locator(".anime-card").count(), 1);
      assert.equal(await page.locator(".anime-card").getAttribute("tabindex"), "0");
      await page.screenshot({ path: "/tmp/anime-countdown-mobile.png" });
    });
    {
      const context = await browser.newContext({ serviceWorkers: "allow", reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(`offline PWA: ${error.message}`));
      try {
        // Follow the checked-in timetable rather than assuming the original July seed.
        const timetable = require("../schedule.json");
        const dates = timetable.releases.map(row => Date.parse(row.releaseDate || "")).filter(Number.isFinite);
        assert.ok(dates.length > 0, "offline fixture needs at least one dated release");
        await page.clock.install({ time: new Date(Math.min(...dates) - 3600000) });
        await page.goto(base);
        await ready(page);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        await page.locator("#showAllBtn").click();
        assert.ok(await page.locator(".anime-card").count() > 0);
        await page.locator('[data-action="favorite"]').first().click();
        await page.evaluate(() => refreshSharedSchedule({ force: true }));
        await ready(page);
        await page.evaluate(async () => {
          await fetch("/api/health");
          await caches.open("another-app-cache");
          await caches.open("anime-countdown-pwa-v98");
        });
        assert.equal(await page.evaluate(async () => Boolean(await caches.match("/api/health"))), false);
        await context.setOffline(true);
        await page.reload();
        await ready(page);
        await page.locator("#showFavsBtn").click();
        assert.ok(await page.locator(".anime-card").count() > 0);
        const keys = await page.evaluate(() => caches.keys());
        assert.ok(keys.includes("another-app-cache"));
        assert.ok(!keys.includes("anime-countdown-pwa-v98"));
        passed++; console.log("PASS installed PWA works offline, preserves favorites, and excludes API responses from caches");
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    console.log(`${passed} browser scenarios passed, no uncaught JavaScript errors`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
