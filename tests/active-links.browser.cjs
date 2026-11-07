"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
module.exports = async ({ scenario, base, ready, nativeMock }) => {
  async function setup(page) {
    await page.goto(base); await ready(page);
    await page.evaluate(() => {
      const row = state.releases[0];
      state.releases = [{ ...row, anilistId: 999, favorite: true, service: "Netflix", allServices: ["Netflix", "Crunchyroll", "Prime Video", "Disney+"], serviceUrl: "https://ejemplo.test/netflix",
        serviceUrls: { Netflix: "https://ejemplo.test/netflix", Crunchyroll: "https://ejemplo.test/crunchyroll", "Prime Video": "https://ejemplo.test/prime", "Disney+": "https://ejemplo.test/disney" },
        platformsByCountry: {}, customUrl: "https://ejemplo.test/custom", customPlatformName: "MiSitio" }];
      state.personalSearchTemplate = "https://ejemplo.test/media/{titulo}";
      state.personalLinkName = "Mi búsqueda";
      invalidateDataCaches(); setMode("all");
    });
  }
  async function open(page) { await page.locator(".anime-card").first().dispatchEvent("contextmenu"); }
  async function choose(page, value) {
    const radio = page.locator(`#activeLinkOptions input[value="${value}"]`);
    if (value === "auto") await radio.click(); else await radio.check();
    await page.waitForFunction(value => (getUserOverride(state.releases[0])?.activeLink || "auto") === value
      && document.querySelector(".badge-purple")?.textContent === (getActiveWatchSource(state.releases[0])?.label || "Sin plataforma"), value);
    await page.evaluate(() => storageWriteQueue);
  }
  // Cleanup of retired Jellyfin preferences must preserve all unrelated local data.
  await scenario("F10 cleans legacy Jellyfin server and active choice once", async page => {
    await page.addInitScript(() => {
      if (localStorage.getItem("animeCountdownStorage")) return;
      localStorage.setItem("animeCountdownStorage", JSON.stringify({ jellyfinServer: "http://servidor.test:8096", otherSetting: "keep", userOverrides: {
        sample: { keys: ["sample"], title: "Sample", activeLink: "jellyfin", favorite: true, customUrl: "https://ejemplo.test/custom", customPlatformName: "MiSitio", extra: "keep" },
        absent: { keys: ["absent"], activeLink: "jellyfin", favorite: false, extra: "keep-absent" },
        personal: { keys: ["personal"], activeLink: "personal", extra: "keep-personal" }
      } }));
    });
    await page.goto(base); await ready(page);
    await page.evaluate(() => setMode("all"));
    const inspect = () => page.evaluate(async () => {
      const overrides = (await browserApi.storage.local.get(["userOverrides"])).userOverrides;
      const small = JSON.parse(localStorage.getItem("animeCountdownStorage"));
      return { removedServer: !Object.hasOwn(small, "jellyfinServer"), otherSetting: small.otherSetting,
        noSelection: !Object.hasOwn(overrides.sample, "activeLink") && !Object.hasOwn(overrides.absent, "activeLink"),
        custom: overrides.sample.customUrl, name: overrides.sample.customPlatformName, favorite: overrides.sample.favorite, extra: overrides.sample.extra,
        absent: overrides.absent.extra, personal: overrides.personal.activeLink,
        active: getActiveWatchSource(state.releases.find(row => row.id === "sample-4"))?.id };
    });
    const expected = { removedServer: true, otherSetting: "keep", noSelection: true, custom: "https://ejemplo.test/custom", name: "MiSitio", favorite: true, extra: "keep", absent: "keep-absent", personal: "personal", active: "custom" };
    assert.deepEqual(await inspect(), expected);
    assert.equal(await page.locator('.anime-card[data-id="sample-4"] .primary-link').textContent(), "Ver en MiSitio");
    assert.equal(await page.getByText(/Jellyfin/).count(), 0);
    await page.locator('.anime-card[data-id="sample-4"]').dispatchEvent("contextmenu");
    assert.equal(await page.locator('input[value="jellyfin"]').count(), 0);
    assert.equal(await page.locator('input[value="auto"]').isChecked(), true);
    await page.reload(); await ready(page);
    assert.deepEqual(await inspect(), expected);
    // Also cover upgrades from IndexedDB while offline, including already scheduled native alarms.
    const id = await page.evaluate(async () => {
      const overrides = (await browserApi.storage.local.get(["userOverrides"])).userOverrides;
      overrides.sample.activeLink = "jellyfin";
      const db = await openStateDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("state", "readwrite");
        tx.objectStore("state").put(overrides, "userOverrides");
        tx.oncomplete = resolve; tx.onerror = reject;
      });
      const small = JSON.parse(localStorage.getItem("animeCountdownStorage"));
      Object.assign(small, { jellyfinServer: "http://servidor.test:8096", notificationEnabled: true, nativeNotificationVersion: 1, lastNativeNotificationSync: new Date().toISOString() });
      localStorage.setItem("animeCountdownStorage", JSON.stringify(small));
      return hashNotificationId(state.releases.find(row => row.id === "sample-4"));
    });
    await page.addInitScript(id => {
      window.pendingNative = [{ id, body: "Ya disponible.", extra: { url: "http://servidor.test:8096/web/#/search.html?query=Sample" } }];
      window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
        checkPermissions: async () => ({ display: "granted" }), checkExactNotificationSetting: async () => ({ exact_alarm: "granted" }),
        createChannel: async () => {}, getPending: async () => ({ notifications: pendingNative.slice() }),
        cancel: async ({ notifications }) => { pendingNative = pendingNative.filter(n => !notifications.some(c => c.id === n.id)); },
        schedule: async ({ notifications }) => { pendingNative = notifications; }
      } } };
    }, id);
    await page.route("**/schedule.json", route => route.abort());
    await page.reload(); await ready(page);
    await page.clock.runFor(5000);
    assert.deepEqual(await inspect(), expected);
    assert.deepEqual(await page.evaluate(() => pendingNative.map(n => [n.body, n.extra.url])), [["Ya disponible.", "https://ejemplo.test/custom"]]);
  });
  await scenario("F9 source radios, priority, badges, secondary links and constant count", async page => {
    await setup(page); await open(page);
    assert.equal(await page.locator('#activeLinkOptions input[type="radio"]').count(), 7);
    const sources = [
      ["platform:Netflix", "Netflix", "Ver en Netflix", "https://ejemplo.test/netflix", null],
      ["platform:Crunchyroll", "Crunchyroll", "Ver en Crunchyroll", "https://ejemplo.test/crunchyroll", null],
      ["platform:Prime Video", "Prime Video", "Ver en Prime Video", "https://ejemplo.test/prime", null],
      ["platform:Disney+", "Disney+", "Ver en Disney+", "https://ejemplo.test/disney", null],
      ["personal", "Mi búsqueda", "Ver en Mi búsqueda", "https://ejemplo.test/media/Sample", null],
      ["custom", "MiSitio", "Ver en MiSitio", "https://ejemplo.test/custom", "Mi búsqueda"],
      ["auto", "MiSitio", "Ver en MiSitio", "https://ejemplo.test/custom", "Mi búsqueda"]
    ];
    for (const [value, badge, label, url, secondary] of sources) {
      await choose(page, value);
      assert.equal(await page.locator(".anime-card").count(), 1);
      assert.equal(await page.locator(".badge-purple").textContent(), badge);
      assert.equal(await page.locator(".primary-link").textContent(), label);
      assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), url);
      assert.deepEqual(await page.locator('[data-action="secondary"]').allTextContents(), secondary ? [secondary] : []);
    }
    assert.equal(await page.evaluate(() => Object.hasOwn(getUserOverride(state.releases[0]), "activeLink")), false);
    await page.evaluate(() => { state.hiddenPlatforms = ["Netflix"]; invalidateDataCaches(); render(); });
    assert.match(await page.locator('label:has(input[value="platform:Netflix"])').textContent(), /desmarcada/);
    await choose(page, "platform:Netflix");
    assert.equal(await page.evaluate(() => getDisplayService(state.releases[0])), "Netflix");
    await page.evaluate(() => { state.releases[0].customPlatformName = "Netflix"; invalidateDataCaches(); render(); });
    await choose(page, "custom");
    assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), "https://ejemplo.test/custom");
    assert.equal(await page.evaluate(() => getDisplayService(state.releases[0])), "No legal platform");
  });
  await scenario("F9 long press, movement, early release, normal clicks and keyboard focus", async page => {
    await setup(page);
    await page.evaluate(() => { window.openedUrls = []; openExternalUrl = url => openedUrls.push(url); });
    const card = page.locator(".anime-card");
    await card.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 1, clientX: 50, clientY: 100 });
    await page.clock.runFor(300);
    await card.dispatchEvent("pointerup", { pointerId: 1 });
    await page.clock.runFor(300);
    assert.equal(await page.locator("#linkDialog").isVisible(), false);
    await card.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 2, clientX: 50, clientY: 100 });
    await card.dispatchEvent("pointermove", { pointerId: 2, clientX: 65, clientY: 100 });
    await page.clock.runFor(600);
    assert.equal(await page.locator("#linkDialog").isVisible(), false);
    await card.dispatchEvent("pointercancel", { pointerId: 2 });
    await card.click({ position: { x: 15, y: 15 } });
    assert.deepEqual(await page.evaluate(() => openedUrls), ["https://ejemplo.test/custom"]);
    await card.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerType: "touch", pointerId: 3, clientX: 50, clientY: 100 });
    await page.clock.runFor(501);
    assert.equal(await page.locator("#linkDialog").isVisible(), true);
    await card.dispatchEvent("pointerup", { pointerId: 3 });
    await card.dispatchEvent("click");
    assert.deepEqual(await page.evaluate(() => openedUrls), ["https://ejemplo.test/custom"]);
    assert.equal(await page.locator("#linkDialog").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("anime-card"));
    await open(page);
    assert.equal(await page.getByRole("dialog").getAttribute("aria-modal"), "true");
    assert.equal(await page.locator("#closeLinkDialog").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator("#linkDialog").evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#closeLinkDialog").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#linkDialog").isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.classList.contains("anime-card"));
    await open(page);
    await page.mouse.click(2, 2);
    assert.equal(await page.locator("#linkDialog").isVisible(), false);
    await card.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerType: "touch", pointerId: 5, clientX: 50, clientY: 100 });
    await page.clock.runFor(100);
    await card.dispatchEvent("contextmenu");
    await card.dispatchEvent("pointerup", { pointerId: 5 });
    await page.locator("#closeLinkDialog").dispatchEvent("click");
    assert.equal(await page.locator("#linkDialog").isVisible(), true);
    await page.keyboard.press("Escape");
    const box = await card.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down(); await page.clock.runFor(550);
    assert.equal(await page.locator("#linkDialog").isVisible(), true);
    await page.mouse.up();
    assert.equal(await page.locator("#linkDialog").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => openedUrls), ["https://ejemplo.test/custom"]);
    await page.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.locator(".primary-link").dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 4 });
    await page.clock.runFor(550);
    assert.equal(await page.locator("#linkDialog").isVisible(), false);
    assert.equal(await page.locator("#settingsBtn").dispatchEvent("contextmenu").then(() => page.locator("#linkDialog").isVisible()), false);
  });
  await scenario("F9 personal name trims, limits, escapes, defaults and survives reload", async page => {
    await setup(page);
    await page.evaluate(() => { state.releases[0].customUrl = ""; state.hiddenPlatforms = getDetectedPlatforms(); invalidateDataCaches(); render(); });
    await page.locator("#settingsBtn").click();
    const input = page.getByRole("textbox", { name: "Nombre del enlace personal", exact: true });
    await input.fill('  <Mi & enlace>  ');
    await page.evaluate(() => storageWriteQueue);
    assert.equal(await page.locator(".badge-purple").textContent(), "<Mi & enlace>");
    assert.equal(await page.locator(".primary-link").textContent(), "Ver en <Mi & enlace>");
    assert.equal(await page.locator(".badge-purple *").count(), 0);
    await input.evaluate(el => { el.value = "  " + "a".repeat(35); el.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.evaluate(() => state.personalLinkName.length), 30);
    await input.fill("");
    await page.evaluate(() => storageWriteQueue);
    assert.equal(await page.locator(".badge-purple").textContent(), "Enlace personal");
    assert.equal(await page.locator(".primary-link").textContent(), "Buscar");
    await input.fill("Mi búsqueda");
    await page.evaluate(() => storageWriteQueue);
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#personalLinkNameInput").inputValue(), "Mi búsqueda");
  });
  await scenario("F9 own link validation, save, remove, explicit override and all episodes", async page => {
    await setup(page);
    await page.evaluate(() => { state.releases = state.releases.map(item => ({ ...item, customUrl: "", customPlatformName: "" })); invalidateDataCaches(); render(); });
    await page.getByRole("button", { name: "Asociar link", exact: true }).click();
    assert.equal(await page.locator("#customLinkName").evaluate(el => el === document.activeElement), true);
    await page.locator("#customLinkName").fill("Netflix");
    for (const invalid of ["", "http://ejemplo.test/custom", "javascript:alert(1)", "https://user:pass@ejemplo.test/custom"]) {
      await page.locator("#customLinkAddress").fill(invalid);
      await page.getByRole("button", { name: "Guardar enlace", exact: true }).click();
      assert.equal(await page.locator("#customLinkError").isVisible(), true);
    }
    await page.locator("#customLinkAddress").fill("https://ejemplo.test/nuevo");
    await page.getByRole("button", { name: "Guardar enlace", exact: true }).click();
    await page.waitForFunction(() => state.releases[0].customUrl === "https://ejemplo.test/nuevo");
    assert.equal(await page.locator("#customLinkError").isVisible(), false);
    assert.equal(await page.locator(".primary-link").textContent(), "Ver en Netflix");
    await page.evaluate(() => { state.hiddenPlatforms = ["Netflix"]; invalidateDataCaches(); render(); });
    assert.equal(await page.locator(".badge-purple").textContent(), "Crunchyroll");
    await choose(page, "custom");
    assert.equal(await page.locator(".badge-purple").textContent(), "Netflix");
    await page.locator("#customLinkName").fill("");
    await page.getByRole("button", { name: "Guardar enlace", exact: true }).click();
    await page.waitForFunction(() => state.releases[0].customPlatformName === "" && document.querySelector(".primary-link")?.textContent === "Ver en link asociado");
    assert.equal(await page.locator(".primary-link").textContent(), "Ver en link asociado");
    await page.evaluate(() => {
      const row = state.releases[0];
      state.releases.push({ ...row, id: "another-episode", animeKey: "other-route", anilistId: row.anilistId, releaseDate: "2026-11-01T18:00:00Z" });
    });
    await page.getByRole("button", { name: "Quitar enlace", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#activeLinkOptions input[value="custom"]') === null);
    assert.equal(await page.evaluate(() => state.releases.every(item => !item.customUrl && !item.customPlatformName)), true);
    assert.equal(await page.locator('#activeLinkOptions input[value="custom"]').count(), 0);
    assert.equal(await page.evaluate(() => getUserOverride(state.releases[0]).activeLink), "custom");
    assert.equal(await page.locator(".badge-purple").textContent(), "Crunchyroll");
  });
  await scenario("F9 persistence, unavailable source fallback and schedule refresh", async page => {
    await setup(page); await open(page); await choose(page, "personal");
    await page.evaluate(async () => { await browserApi.storage.local.set({ personalSearchTemplate: state.personalSearchTemplate, personalLinkName: state.personalLinkName }); });
    await page.reload(); await ready(page);
    await page.evaluate(() => setMode("all"));
    assert.equal(await page.locator('.anime-card[data-id="sample-4"] .badge-purple').textContent(), "Mi búsqueda");
    await page.evaluate(async () => { state.personalSearchTemplate = ""; await browserApi.storage.local.set({ personalSearchTemplate: "" }); invalidateDataCaches(); render(); });
    assert.equal(await page.evaluate(() => getUserOverride(state.releases.find(r => r.id === "sample-4")).activeLink), "personal");
    assert.notEqual(await page.evaluate(() => getActiveWatchSource(state.releases.find(r => r.id === "sample-4")).id), "personal");
    await page.evaluate(() => { state.personalSearchTemplate = "https://ejemplo.test/media/{titulo}"; invalidateDataCaches(); render(); });
    assert.equal(await page.locator('.anime-card[data-id="sample-4"] .badge-purple').textContent(), "Mi búsqueda");
    await page.route("**/schedule.json", route => route.fulfill({ json: { source: "AnimeSchedule", checkedAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z", releases: [{ id: "fresh", animeKey: "sample", title: "Sample", titles: ["Sample"], episode: "Ep 5", episodeNumber: "5", airType: "SUB", releaseDate: "2026-10-31T18:00:00Z", service: "Netflix", serviceUrl: "https://ejemplo.test/netflix" }] } }));
    await page.evaluate(() => refreshSharedSchedule({ force: true }));
    assert.equal(await page.locator('.anime-card[data-id="fresh"] .badge-purple').textContent(), "Mi búsqueda");
    await page.locator('.anime-card[data-id="fresh"]').dispatchEvent("contextmenu");
    await page.evaluate(() => { state.personalSearchTemplate = ""; invalidateDataCaches(); render(); });
    assert.equal(await page.evaluate(() => getUserOverride(state.releases[0]).activeLink), "personal");
    assert.notEqual(await page.evaluate(() => getActiveWatchSource(state.releases[0])?.id), "personal");
    await choose(page, "auto");
    assert.equal(await page.evaluate(() => Object.hasOwn(getUserOverride(state.releases[0]), "activeLink")), false);
  });
  await scenario("F9 chosen source updates native and web notifications without waiting", async page => {
    await nativeMock(page);
    await page.evaluate(async () => {
      state.releases = [{ ...state.releases[0], favorite: true, service: "Netflix", allServices: ["Netflix"], serviceUrl: "https://ejemplo.test/netflix", customUrl: "https://ejemplo.test/custom", customPlatformName: "MiSitio" }];
      state.personalSearchTemplate = "https://ejemplo.test/{titulo}";
      state.hiddenPlatforms = ["Netflix"];
      invalidateDataCaches(); setMode("all");
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ showNotification: async (title, options) => { window.webNotification = options; } }) } });
      await syncNativeNotificationsIfNeeded({ force: true });
    });
    await open(page);
    for (const [id, body, url] of [["platform:Netflix", "Ya disponible en Netflix.", "https://ejemplo.test/netflix"], ["personal", "Ya disponible.", "https://ejemplo.test/Sample"], ["custom", "Ya disponible.", "https://ejemplo.test/custom"]]) {
      await choose(page, id); await page.clock.runFor(5000);
      await page.evaluate(() => showReleaseNotification(state.releases[0]));
      assert.deepEqual(await page.evaluate(() => [nativeTest.pending[0].body, nativeTest.pending[0].extra.url, webNotification.body, webNotification.data.url]), [body, url, body, url]);
    }
  });
  await scenario("F9 Android back and floating 360px dialog in both themes", async page => {
    await page.addInitScript(() => {
      window.backExits = 0;
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { App: { addListener: async (name, cb) => { window.nativeBack = cb; }, exitApp: () => { backExits++; } } } };
    });
    await setup(page);
    fs.mkdirSync("/tmp/f10-screenshots", { recursive: true });
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.evaluate(theme => applyTheme(theme), theme);
      await open(page);
      await page.screenshot({ path: `/tmp/f10-screenshots/360-series-${theme}.png`, animations: "disabled" });
      assert.equal(await page.locator("#linkDialog").evaluate(el => { const r = el.getBoundingClientRect(); return r.left > 0 && r.right < innerWidth && r.top > 0 && r.bottom < innerHeight && el.scrollWidth <= el.clientWidth; }), true);
      await page.evaluate(() => nativeBack({ canGoBack: false }));
      assert.equal(await page.locator("#linkDialog").isVisible(), false);
      assert.equal(await page.evaluate(() => backExits), 0);
      await page.locator("#settingsBtn").click();
      await page.locator("#settingsPanel").evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: `/tmp/f10-screenshots/360-settings-${theme}.png`, animations: "disabled" });
      await page.locator("#settingsPanel").evaluate(el => el.scrollTop = el.scrollHeight);
      await page.screenshot({ path: `/tmp/f10-screenshots/360-settings-lower-${theme}.png`, animations: "disabled" });
      assert.equal(await page.locator("#settingsPanel").evaluate(el => { const r = el.getBoundingClientRect(); return r.left > 0 && r.right < innerWidth && el.scrollWidth <= el.clientWidth; }), true);
      await page.locator("#closeSettingsBtn").click();
    }
  });
};
