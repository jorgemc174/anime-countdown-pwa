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
  async function scenario(name, fn, timezoneId = "Europe/Madrid") {
    if (process.env.BROWSER_SCENARIO && !name.includes(process.env.BROWSER_SCENARIO)) return;
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, timezoneId, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
    await page.clock.install({ time: new Date(now) });
    await page.route("https://**/*", route => route.abort());
    await page.route("**/schedule.json", route => route.fulfill({ json: payload }));
    try { await fn(page, context); passed++; console.log("PASS", name); }
    finally { await context.close(); }
  }
  try {
    for (const rule of ["unchanged", "alternative", "hidden", "unknown", "unknown-on", "custom", "custom-link", "favorite", "favorite-unknown"]) {
      await scenario(`subscriptions ${rule}: lists, count and next episode`, async page => {
        await page.goto(base); await ready(page);
        const result = await page.evaluate(rule => {
          const item = { ...state.releases[0], allServices: ["Crunchyroll", "Netflix"], favorite: rule.startsWith("favorite") };
          if (rule === "hidden" || rule === "favorite") item.allServices = ["Crunchyroll"];
          if (["unknown", "unknown-on", "favorite-unknown"].includes(rule)) { item.service = "No legal platform"; item.allServices = []; }
          if (rule === "custom") item.customPlatformName = "Crunchyroll";
          if (rule === "custom-link") { item.customUrl = "https://example.com/watch"; item.allServices = []; }
          state.releases = [item];
          state.hiddenPlatforms = rule === "unchanged" ? [] : rule === "unknown-on" ? ["Crunchyroll"] : ["Crunchyroll", "No legal platform"];
          invalidateDataCaches(); setMode("all");
          const all = { count: document.querySelectorAll(".anime-card").length, title: $("listTitle").textContent, next: state.currentNext?.id || null, text: $("animeList").textContent, service: getDisplayService(item), platforms: getDetectedPlatforms(), nextText: $("nextRelease").textContent };
          setMode("today");
          const today = document.querySelectorAll(".anime-card").length;
          setMode("favorites");
          return { all, today, favorites: document.querySelectorAll(".anime-card").length };
        }, rule);
        const visible = !["hidden", "unknown"].includes(rule);
        assert.equal(result.all.count, Number(visible));
        assert.ok(result.all.title.endsWith(` · ${Number(visible)}`));
        assert.equal(Boolean(result.all.next), visible);
        assert.equal(result.today, Number(rule.startsWith("favorite")));
        assert.equal(result.favorites, Number(rule.startsWith("favorite")));
        if (rule === "hidden" || rule === "unknown") { assert.match(result.all.text, /filtros/i); assert.match(result.all.nextText, /filtros/i); }
        if (rule === "alternative") assert.equal(result.all.service, "Netflix");
        if (rule === "favorite") assert.equal(result.all.service, "Crunchyroll");
        if (rule === "hidden") assert.ok(result.all.platforms.includes("Crunchyroll"));
        if (rule === "unknown") assert.ok(result.all.platforms.includes("No legal platform"));
      });
    }
    await scenario("subscriptions hide pending rows and keep detected chips", async page => {
      await page.goto(base); await ready(page);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 2);
      await page.evaluate(() => togglePlatformFilter("Crunchyroll"));
      assert.equal(await page.locator(".anime-card").count(), 0);
      assert.equal(await page.locator('[data-platform="Crunchyroll"]').getAttribute("aria-pressed"), "false");
      await page.evaluate(() => togglePlatformFilter("Crunchyroll"));
      assert.equal(await page.locator(".anime-card").count(), 2);
    });
    await scenario("device timezone falls back for missing or invalid OS zone", async page => {
      await page.goto(base); await ready(page);
      assert.deepEqual(await page.evaluate(() => {
        const Original = Intl.DateTimeFormat;
        try {
          return [undefined, "not/a/timezone"].map(timeZone => {
            Intl.DateTimeFormat = new Proxy(Original, { apply: () => ({ resolvedOptions: () => ({ timeZone }) }) });
            return getDeviceTimezone();
          });
        } finally { Intl.DateTimeFormat = Original; }
      }), ["Europe/Madrid", "Europe/Madrid"]);
    });
    await scenario("subscriptions favorite notification keeps real platform", async page => {
      await page.goto(base); await ready(page);
      const bodies = await page.evaluate(async () => {
        const scheduled = [];
        window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
          getPending: async () => ({ notifications: [] }), schedule: async ({ notifications }) => scheduled.push(...notifications)
        } } };
        state.notificationEnabled = true;
        state.hiddenPlatforms = ["Crunchyroll"];
        const item = { ...state.releases[0], favorite: true, allServices: ["Crunchyroll"] };
        state.releases = [item];
        await scheduleNativeNotifications();
        return scheduled.map(n => n.body);
      });
      assert.deepEqual(bodies, ["Ya disponible en Crunchyroll."]);
    });
    for (const zone of ["Europe/Madrid", "America/Los_Angeles"]) {
      await scenario(`device timezone ${zone} ignores storage and updates on return`, async (page, context) => {
        await page.addInitScript(() => localStorage.setItem("animeCountdownStorage", JSON.stringify({ timezone: "Asia/Tokyo" })));
        await page.goto(base); await ready(page);
        assert.equal(await page.locator("#timezoneInput").count(), 0);
        assert.equal(await page.evaluate(() => state.timezone), zone);
        const inspect = () => page.evaluate(() => {
          state.releases = [{ ...state.releases[0], favorite: true, releaseDate: "2026-10-31T00:30:00Z" }];
          invalidateDataCaches(); setMode("today");
          return { count: getVisibleItems().length, date: formatDate(state.releases[0].releaseDate) };
        });
        const initial = await inspect();
        assert.equal(initial.count, Number(zone === "America/Los_Angeles"));
        assert.match(initial.date, zone === "Europe/Madrid" ? /01:30/ : /17:30/);
        const other = zone === "Europe/Madrid" ? "America/Los_Angeles" : "Europe/Madrid";
        // Chromium cannot replace Playwright's active timezone override. Simulate
        // the OS reporting a new zone; explicit-zone formatting still uses Intl.
        await page.evaluate(other => {
          const Original = Intl.DateTimeFormat;
          Intl.DateTimeFormat = new Proxy(Original, {
            apply(target, receiver, args) {
              return args.length ? Reflect.apply(target, receiver, args) : new Original("es", { timeZone: other });
            }
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }, other);
        assert.equal(await page.evaluate(() => state.timezone), other);
        assert.equal(await page.evaluate(() => getVisibleItems().length), 1 - initial.count);
      }, zone);
    }
    await scenario("settings opens with close focus and Escape restores the trigger", async page => {
      await page.goto(base); await ready(page);
      await page.locator("#settingsBtn").click();
      assert.equal(await page.locator("#closeSettingsBtn").evaluate(el => el === document.activeElement), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#settingsPanel").isVisible(), false);
      assert.equal(await page.locator("#settingsBtn").evaluate(el => el === document.activeElement), true);
    });
    await scenario("settings filter counts follow pressed chips", async page => {
      await page.goto(base); await ready(page);
      await page.locator("#settingsBtn").click();
      for (const [container, counter] of [["platformFilterContainer", "platformFilterCount"], ["contentFilterContainer", "contentFilterCount"]]) {
        const details = page.locator(`#${container}`).locator("..");
        await details.locator("summary").click();
        const chip = page.locator(`#${container} button`).first();
        const before = await chip.getAttribute("aria-pressed");
        assert.ok(["true", "false"].includes(before));
        await chip.click();
        assert.equal(await chip.getAttribute("aria-pressed"), before === "true" ? "false" : "true");
        assert.equal(await chip.evaluate(el => el === document.activeElement), true);
        const active = await page.locator(`#${container} [aria-pressed="true"]`).count();
        const total = await page.locator(`#${container} button`).count();
        assert.equal(await page.locator(`#${counter}`).innerText(), `${active} de ${total}`);
        assert.equal(await page.locator(`#${container} [aria-pressed="true"] svg`).count(), active);
      }
    });
    await scenario("settings fits mobile and desktop in both themes with accessible touch targets", async page => {
      await page.goto(base); await ready(page);
      await page.locator("#settingsBtn").click();
      await page.locator("#settingsPanel details").evaluateAll(nodes => nodes.forEach(el => el.open = true));
      fs.mkdirSync("/tmp/ajustes", { recursive: true });
      for (const width of [360, 390, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ["dark", "light"]) {
          await page.evaluate(theme => applyTheme(theme), theme);
          await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
          const contrast = await page.locator("#settingsPanel").evaluate(panel => {
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = value => rgb(value).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            return [...panel.querySelectorAll(".filter-help, .filter-count, .platform-chip")].map(el => {
              const style = getComputedStyle(el);
              let parent = el;
              while (getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
              const a = luminance(style.color), b = luminance(getComputedStyle(parent).backgroundColor);
              return { text: el.textContent.slice(0, 40), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), color: style.color, background: getComputedStyle(parent).backgroundColor };
            }).filter(result => result.ratio < 4.5);
          });
          assert.deepEqual(contrast, [], `${width} ${theme}: text contrast`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && els.settingsPanel.scrollWidth <= els.settingsPanel.clientWidth), true);
          assert.equal(await page.locator("#settingsPanel summary").evaluateAll(nodes => nodes.every(el => { const r = el.getBoundingClientRect(); return r.height >= 44 && r.width >= 44; })), true);
          await page.locator("#settingsPanel").evaluate(el => el.scrollTop = 0);
          await page.screenshot({ path: `/tmp/ajustes/${width}-${theme}.png` });
          await page.locator("#settingsPanel").evaluate(el => el.scrollTop = el.scrollHeight);
          await page.screenshot({ path: `/tmp/ajustes/${width}-${theme}-inferior.png` });
          assert.equal(await page.locator("#settingsPanel").evaluate(el => { const r = el.getBoundingClientRect(); return r.left > 0 && r.right < innerWidth && r.top > 0; }), true, `${width} ${theme}: floating panel`);
          assert.equal(await page.locator("#closeSettingsBtn").evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
        }
      }
    });
    for (const action of ["enable", "reset"]) {
      await scenario(`native ${action} forces reconciliation despite recent sync and subsequent checks`, async (page, context) => {
        await context.grantPermissions(["notifications"]);
        await page.goto(base); await ready(page);
        await page.evaluate(async action => {
          window.nativeResult = { cancelled: [], scheduled: [] };
          window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
            requestPermissions: async () => ({ display: "granted" }),
            createChannel: async () => {},
            checkPermissions: async () => ({ display: "granted" }),
            checkExactNotificationSetting: async () => ({ exact_alarm: "granted" }),
            getPending: async () => ({ notifications: action === "reset" ? [{ id: 123 }] : [] }),
            cancel: async value => nativeResult.cancelled.push(...value.notifications),
            schedule: async value => nativeResult.scheduled.push(...value.notifications)
          } } };
          state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
          state.nativeNotificationVersion = 1;
          state.lastNativeNotificationSync = new Date().toISOString();
          state.notificationEnabled = action === "reset";
          window.confirm = () => true;
          if (action === "reset") await resetAll(); else await toggleNotifications();
          checkReleaseNotifications();
        }, action);
        await page.clock.runFor(5000);
        assert.equal(await page.evaluate(action => action === "reset" ? nativeResult.cancelled.length : nativeResult.scheduled.length, action), 1);
        assert.equal(await page.evaluate(() => nativeResult.scheduled.length), action === "reset" ? 0 : 1);
      });
    }
    async function nativeMock(page) {
      await page.goto(base); await ready(page);
      await page.evaluate(() => {
        window.nativeTest = { pending: [], cancelled: [], scheduled: [], channels: [], display: "granted", exact: "granted", calls: 0 };
        window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
          checkPermissions: async () => ({ display: nativeTest.display }),
          checkExactNotificationSetting: async () => ({ exact_alarm: nativeTest.exact }),
          createChannel: async channel => nativeTest.channels.push(channel),
          getPending: async () => ({ notifications: nativeTest.pending.slice() }),
          cancel: async ({ notifications }) => {
            nativeTest.cancelled.push(...notifications);
            nativeTest.pending = nativeTest.pending.filter(n => !notifications.some(c => c.id === n.id));
          },
          schedule: async ({ notifications }) => {
            nativeTest.calls++;
            if (nativeTest.block) await nativeTest.block;
            if (nativeTest.fail) throw new Error("Simulated scheduling failure");
            nativeTest.scheduled.push(...notifications);
            nativeTest.pending = nativeTest.pending.filter(n => !notifications.some(next => next.id === n.id));
            nativeTest.pending.push(...notifications);
          }
        } } };
        state.notificationEnabled = true;
      });
    }
    await scenario("native idle alarms cover fourteen days on an explicit channel and show coverage", async page => {
      const consoleErrors = [];
      page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        const item = state.releases.find(row => row.releaseDate);
        state.releases = [10, 15].map(days => ({ ...item, id: `day-${days}`, favorite: true, releaseDate: new Date(Date.now() + days * 86400000).toISOString() }));
        const before = Date.now();
        await syncNativeNotificationsIfNeeded({ force: true });
        return { ...nativeTest, before, until: state.nativeNotificationsUntil };
      });
      assert.equal(result.scheduled.length, 1);
      assert.equal(result.scheduled[0].schedule.allowWhileIdle, true);
      assert.equal(result.scheduled[0].channelId, "anime-releases");
      assert.equal(result.channels[0].id, "anime-releases");
      assert.equal(result.channels[0].importance, 4);
      assert.ok(Math.abs(Date.parse(result.until) - result.before - 14 * 86400000) < 2000);
      await page.locator("#settingsBtn").click();
      assert.match(await page.locator("#nativeNotificationStatus").innerText(), /Programados hasta el 13 de noviembre de 2026/);
      // Coverage and migration survive a new app instance.
      await page.reload(); await ready(page);
      assert.equal(await page.evaluate(() => state.nativeNotificationsUntil), result.until);
      assert.equal(await page.evaluate(() => state.nativeNotificationVersion), 1);
      assert.deepEqual(consoleErrors, []);
    });
    await scenario("native existing pending IDs are rescheduled with current platform text", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true, service: "Netflix", serviceUrl: "https://www.netflix.com/" }];
        const id = hashNotificationId(state.releases[0]);
        nativeTest.pending = [{ id, body: "Ya disponible en Crunchyroll." }];
        await scheduleNativeNotifications();
        return { id, scheduled: nativeTest.scheduled };
      });
      assert.equal(result.scheduled.length, 1);
      assert.equal(result.scheduled[0].id, result.id);
      assert.equal(result.scheduled[0].schedule.allowWhileIdle, true);
      assert.equal(result.scheduled[0].body, "Ya disponible en Netflix.");
    });
    for (const granted of [false, true]) {
      await scenario(`native revoked permission click requests access: granted=${granted}`, async page => {
        await nativeMock(page);
        await page.evaluate(granted => {
          state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
          state.nativeDisplayPermission = "denied";
          state.nativeNotificationVersion = 1;
          state.lastNativeNotificationSync = new Date().toISOString();
          nativeTest.display = "denied";
          nativeTest.requests = 0;
          nativeTest.pending = [{ id: hashNotificationId(state.releases[0]) }];
          Capacitor.Plugins.LocalNotifications.requestPermissions = async () => {
            nativeTest.requests++;
            nativeTest.display = granted ? "granted" : "denied";
            return { display: nativeTest.display };
          };
          updateNotificationButton();
        }, granted);
        await page.locator("#settingsBtn").click();
        assert.equal(await page.locator("#notificationBtn").getAttribute("aria-checked"), "false");
        await page.locator("#notificationBtn").click();
        assert.equal(await page.evaluate(() => nativeTest.requests), 1);
        if (granted) {
          await page.clock.runFor(5000);
          assert.equal(await page.evaluate(() => nativeTest.scheduled.length), 1);
        } else {
          assert.match(await page.locator("#statusBox").textContent(), /denegado.*Ajustes/);
        }
        assert.equal(await page.evaluate(() => nativeTest.cancelled.length), 0);
        assert.equal(await page.evaluate(() => state.notificationEnabled), granted);
        assert.equal(await page.locator("#notificationBtn").getAttribute("aria-checked"), String(granted));
        assert.equal(await page.evaluate(async () => (await browserApi.storage.local.get("notificationEnabled")).notificationEnabled), granted);
      });
    }
    await scenario("native migration replaces legacy pending entries exactly once", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
        nativeTest.pending = [{ id: hashNotificationId(state.releases[0]) }];
        await syncNativeNotificationsIfNeeded({ force: true });
        await syncNativeNotificationsIfNeeded({ force: true });
        return { cancelled: nativeTest.cancelled.length, scheduled: nativeTest.scheduled.length, pending: nativeTest.pending.length, version: state.nativeNotificationVersion };
      });
      assert.deepEqual(result, { cancelled: 1, scheduled: 2, pending: 1, version: 1 });
    });
    await scenario("native requests during synchronization run after the active operation", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
        let unblock;
        nativeTest.block = new Promise(resolve => { unblock = resolve; });
        const first = syncNativeNotificationsIfNeeded({ force: true });
        while (!nativeTest.calls) await new Promise(resolve => setTimeout(resolve, 10));
        state.releases = [];
        queueNativeNotificationSync({ delay: 0 });
        while (!nativeNotificationSyncPending) await new Promise(resolve => setTimeout(resolve, 10));
        unblock();
        await first;
        return { pending: nativeTest.pending.length, cancelled: nativeTest.cancelled.length };
      });
      assert.deepEqual(result, { pending: 0, cancelled: 1 });
    });
    await scenario("disabling during native scheduling leaves no pending alarms or successful coverage", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
        let unblock;
        nativeTest.block = new Promise(resolve => { unblock = resolve; });
        const first = syncNativeNotificationsIfNeeded({ force: true });
        while (!nativeTest.calls) await new Promise(resolve => setTimeout(resolve, 10));
        await toggleNotifications();
        unblock();
        await first;
        return { pending: nativeTest.pending.length, until: state.nativeNotificationsUntil, enabled: state.notificationEnabled };
      });
      assert.deepEqual(result, { pending: 0, until: "", enabled: false });
    });
    await scenario("native revoked display and exact permissions are visible despite recent sync", async page => {
      await nativeMock(page);
      await page.evaluate(async () => {
        await syncNativeNotificationsIfNeeded({ force: true });
        nativeTest.exact = "denied";
        await syncNativeNotificationsIfNeeded();
      });
      assert.match(await page.locator("#nativeNotificationStatus").textContent(), /alarmas exactas.*Ajustes/i);
      await page.evaluate(async () => {
        nativeTest.display = "denied";
        await syncNativeNotificationsIfNeeded();
      });
      assert.match(await page.locator("#nativeNotificationStatus").textContent(), /permiso.*revocado/i);
      assert.equal(await page.locator("#notificationBtn").getAttribute("aria-checked"), "false");
      assert.doesNotMatch(await page.locator("#nativeNotificationStatus").textContent(), /Programados hasta/);
    });
    await scenario("failed native scheduling leaves migration retryable and coverage unset", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        state.releases = [{ ...state.releases.find(row => row.releaseDate), favorite: true }];
        nativeTest.fail = true;
        await syncNativeNotificationsIfNeeded({ force: true });
        const failed = { version: state.nativeNotificationVersion || 0, until: state.nativeNotificationsUntil || "" };
        nativeTest.fail = false;
        await syncNativeNotificationsIfNeeded({ force: true });
        return { failed, version: state.nativeNotificationVersion, count: nativeTest.scheduled.length };
      });
      assert.deepEqual(result, { failed: { version: 0, until: "" }, version: 1, count: 1 });
    });
    await scenario("native channels tolerate older Android and test reminders use the same channel", async page => {
      await nativeMock(page);
      const result = await page.evaluate(async () => {
        downloadCoverImage = async () => null;
        await testNotification();
        await addTestAnime30s();
        const tests = nativeTest.scheduled.map(n => ({ channel: n.channelId, idle: n.schedule.allowWhileIdle }));
        Capacitor.Plugins.LocalNotifications.createChannel = async () => { throw { code: "UNAVAILABLE" }; };
        await syncNativeNotificationsIfNeeded({ force: true });
        return { tests, version: state.nativeNotificationVersion };
      });
      assert.deepEqual(result.tests, [{ channel: "anime-releases", idle: true }, { channel: "anime-releases", idle: true }]);
      assert.equal(result.version, 1);
    });
    await scenario("native enable ignores a denied web permission", async page => {
      await nativeMock(page);
      const enabled = await page.evaluate(async () => {
        Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
        Capacitor.Plugins.LocalNotifications.requestPermissions = async () => ({ display: "granted" });
        state.notificationEnabled = false;
        await toggleNotifications();
        return state.notificationEnabled;
      });
      assert.equal(enabled, true);
    });
    await scenario("disabling native notifications cancels pending entries only when present", async page => {
      await page.goto(base); await ready(page);
      assert.deepEqual(await page.evaluate(async () => {
        const cancelled = [];
        let notifications = [{ id: 11 }, { id: 22 }];
        window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
          getPending: async () => ({ notifications }),
          cancel: async value => cancelled.push(value)
        } } };
        state.notificationEnabled = true; await toggleNotifications();
        notifications = [];
        state.notificationEnabled = true; await toggleNotifications();
        delete window.Capacitor;
        return { cancelled, enabled: state.notificationEnabled };
      }), { cancelled: [{ notifications: [{ id: 11 }, { id: 22 }] }], enabled: false });
    });
    await scenario("shared adult rows are hidden by default and shown when enabled", async page => {
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [{ ...baseRow, isAdult: true }] } }));
      await page.goto(base); await ready(page);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 0);
      await page.evaluate(() => toggleContentFilter("adult"));
      assert.equal(await page.locator(".anime-card").count(), 1);
    });
    await scenario("cards label only fallback links and isolated tags do not mark adult", async page => {
      await page.goto(base); await ready(page);
      assert.deepEqual(await page.evaluate(() => {
        const sources = ["anilist", "animeschedule", "justwatch", ""];
        return sources.map(platformSource => {
          const card = createCardModern({ ...state.releases[0], platformSource });
          const badge = [...card.querySelectorAll(".badge")].find(el => el.textContent === "Sin verificar");
          return badge?.title || "";
        });
      }), ["Enlace de AniList: puede no estar disponible en tu país", "Enlace de AnimeSchedule: puede no estar disponible en tu país", "", ""]);
      assert.equal(await page.evaluate(() => isSchedulableItem({ tags: [{ name: "Nudity", rank: 90, isAdult: true }] })), true);
    });
    await scenario("ONA is visible by default and its stored filter migrates only once", async page => {
      await page.addInitScript(() => {
        if (!localStorage.getItem("animeCountdownStorage")) localStorage.setItem("animeCountdownStorage", JSON.stringify({ hiddenContent: ["adult", "kodomo", "ona"] }));
      });
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [{ ...baseRow, anilistFormat: "ONA" }] } }));
      await page.goto(base); await ready(page);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator(".anime-card").count(), 1);
      assert.equal(await page.evaluate(() => DEFAULT_HIDDEN_CONTENT.includes("ona")), false);
      assert.equal(await page.evaluate(async () => (await browserApi.storage.local.get(["contentFiltersVersion"])).contentFiltersVersion), 1);
      await page.evaluate(() => toggleContentFilter("ona"));
      await page.reload(); await ready(page);
      assert.equal(await page.evaluate(() => state.hiddenContent.includes("ona")), true);
      assert.equal(await page.locator(".anime-card").count(), 0);
    });
    await scenario("Kodomo matches exact audience tags without hiding Yozakura Family", async page => {
      await page.goto(base); await ready(page);
      assert.deepEqual(await page.evaluate(() => [
        { title: "Mission: Yozakura Family", tags: [{ name: "Family Life" }] },
        { title: "Kids on the Slope", genres: ["Family"] },
        { title: "Kodomo no Anime" }, { tags: [{ name: "KiDs" }] },
        { genres: ["children"] }, { tags: ["preschool"] }, { animeKey: "kodomo-series" }
      ].map(isSchedulableItem)), [true, true, false, false, false, false, false]);
    });
    await scenario("library series matching a schedule row by similar title are not listed as unscheduled", async page => {
      await page.goto(base); await ready(page);
      assert.deepEqual(await page.evaluate(() => {
        const airing = new Date(Date.now() + 86400000).toISOString();
        state.releases = [{ title: "Sasaki to Pii-chan 2nd Season", animeKey: "sasaki-to-pii-chan-2nd-season", anilistId: null, releaseDate: airing }];
        state.anilistLibrary = [
          { title: "Sasaki and Peeps Season 2", titles: ["Sasaki to Pii-chan 2nd Season"], anilistId: 1, anilistAiringDate: airing, source: "anilist-library" },
          { title: "Otra serie distinta", titles: ["Otra serie distinta"], anilistId: 2, anilistAiringDate: airing, source: "anilist-library" }
        ];
        return getUnscheduledLibraryItems().map(item => item.title);
      }), ["Otra serie distinta"]);
    });
    await scenario("AniList favorites without SUB schedules have a separate section only in Favorites", async page => {
      await page.goto(base); await ready(page);
      await page.evaluate(() => {
        state.releases = state.releases.map(item => ({ ...item, favorite: true, anilistId: item.id === "sample-4" ? 1 : null }));
        const library = (id, extra = {}) => ({ id: `library-${id}`, anilistId: id, title: `Library ${id}`, source: "anilist-library", anilistAiringDate: "2026-10-31T18:00:00Z", ...extra });
        state.anilistLibrary = [library(1), library(3), library(4, { favorite: false }), library(5, { anilistAiringDate: "2026-10-29T18:00:00Z" }), library(6, { tags: ["Kids"] }), library(7, { anilistId: null, animeKey: "delayed" }), library(8)];
        invalidateDataCaches(); setMode("favorites");
      });
      assert.equal(await page.locator(".anime-card").count(), 4);
      assert.deepEqual(await page.locator("#animeList h2").allTextContents(), ["Retrasos pendientes de confirmación", "Sin horario de subtítulos"]);
      const card = page.locator('.anime-card[data-id="library-3"]');
      assert.match(await card.innerText(), /Emisión en Japón:/);
      assert.equal(await card.locator(".countdown, .badge-orange").count(), 0);
      await page.evaluate(() => updateLiveCountdowns());
      assert.doesNotMatch(await card.innerText(), /Retrasado|Fecha por confirmar/);
      assert.deepEqual(await page.evaluate(() => getNextHighlightItems().map(item => item.id)), ["sample-4"]);
      assert.deepEqual(await page.evaluate(() => getDueNotificationItems(getFavoriteItems(), Date.parse("2026-10-30T18:00:00Z")).map(item => item.id)), ["sample-4"]);
      assert.deepEqual(await page.evaluate(async () => {
        const scheduled = [];
        window.Capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: {
          getPending: async () => ({ notifications: [] }),
          schedule: async ({ notifications }) => scheduled.push(...notifications)
        } } };
        state.notificationEnabled = true;
        await scheduleNativeNotifications();
        state.notificationEnabled = false;
        delete window.Capacitor;
        return scheduled.map(item => item.extra.title);
      }), ["Sample"]);
      await page.evaluate(() => { state.searchQuery = "Library"; state.sortAsc = false; render(); });
      assert.deepEqual(await page.locator(".anime-card").evaluateAll(cards => cards.map(card => card.dataset.id)), ["library-8", "library-3"]);
      await page.evaluate(() => { state.searchQuery = ""; setMode("today"); });
      assert.equal(await page.locator('[data-id^="library-"]').count(), 0);
      await page.locator("#showAllBtn").click();
      assert.equal(await page.locator('[data-id^="library-"]').count(), 0);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator("#showFavsBtn").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
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
      await ready(page);
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
    await scenario("shared platforms use Spain with a stored MX preference and no country selector", async page => {
      const consoleErrors = [];
      page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      let requests = 0;
      page.on("request", request => { if (/justwatch/i.test(request.url())) requests++; });
      const regional = { ...baseRow, basePlatforms: { service: "Crunchyroll", serviceUrl: baseRow.serviceUrl, allServices: ["Crunchyroll"], hasAllowedPlatform: true }, platformsByCountry: {
        ES: { status: "verified", checkedAt: now, offers: [{ service: "Netflix", url: "https://www.netflix.com/title/shared", monetizationType: "FLATRATE" }] },
        MX: { status: "verified", checkedAt: now, offers: [{ service: "Prime Video", url: "https://www.primevideo.com/detail/shared", monetizationType: "FLATRATE" }] }
      } };
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [regional] } }));
      await page.addInitScript(() => {
        if (!localStorage.getItem("animeCountdownStorage")) localStorage.setItem("animeCountdownStorage", JSON.stringify({ jwCountry: "MX" }));
      });
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      assert.match(await page.locator("#animeList").innerText(), /Netflix/);
      assert.equal(await page.locator("#refreshDataBtn").count(), 0);
      await page.locator("#settingsBtn").click();
      assert.equal(await page.locator("#countryInput").count(), 0);
      assert.equal(await page.evaluate(() => state.jwCountry), "ES");
      assert.equal(await page.evaluate(async () => (await browserApi.storage.local.get("jwCountry")).jwCountry), "ES");
      assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), "https://www.netflix.com/title/shared");
      await page.clock.fastForward(60000);
      assert.equal(requests, 0);
      await page.reload();
      await ready(page);
      assert.equal(await page.evaluate(() => state.releases[0].service), "Netflix");
      assert.deepEqual(consoleErrors, []);
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
    await scenario("unmatched shows open the AniList fallback and later prefer a regional JustWatch result", async page => {
      const row = { ...baseRow, anilistOffers: [{ service: "Hulu", url: "https://www.hulu.com/series/fallback" }], platformsByCountry: { ES: { status: "not-found", offers: [] } } };
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [row] } }));
      await page.goto(base);
      await ready(page);
      await page.locator("#showAllBtn").click();
      assert.match(await page.locator("#animeList").innerText(), /Ver en Hulu/);
      assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), "https://www.hulu.com/series/fallback");
      assert.equal(await page.evaluate(() => state.releases[0].jwVerified), false);
      await page.route("**/schedule.json", route => route.fulfill({ json: { ...payload, releases: [{ ...row, platformsByCountry: { ES: { status: "verified", offers: [{ service: "Netflix", url: "https://www.netflix.com/title/local" }] } } }] } }));
      await page.evaluate(() => refreshSharedSchedule({ force: true }));
      assert.equal(await page.evaluate(() => state.releases[0].service), "Netflix");
      assert.equal(await page.evaluate(() => getBestWatchUrl(state.releases[0])), "https://www.netflix.com/title/local");
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
    if (!process.env.BROWSER_SCENARIO || process.env.BROWSER_SCENARIO === "offline") {
      const context = await browser.newContext({ serviceWorkers: "allow", reducedMotion: "reduce" });
      await context.route("https://**/*", route => route.abort());
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(`offline PWA: ${error.message}`));
      try {
        // Follow the checked-in timetable rather than assuming the original July seed.
        const timetable = require("../schedule.json");
        const dates = timetable.releases.map(row => Date.parse(row.releaseDate || "")).filter(Number.isFinite);
        assert.ok(dates.length > 0, "offline fixture needs at least one dated release");
        await page.clock.install({ time: new Date(Math.min(...dates) - 3600000) });
        // Seed older caches before activation, which owns their cleanup.
        await page.goto(base + "/manifest.json");
        await page.evaluate(async () => {
          await caches.open("another-app-cache");
          await caches.open("anime-countdown-pwa-v98");
        });
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
        });
        assert.equal(await page.evaluate(async () => Boolean(await caches.match("/api/health"))), false);
        // A later startup must retain the active worker's precache too.
        await page.reload();
        await ready(page);
        assert.equal(await page.evaluate(async () => Boolean(await caches.match("/index.html"))), true, "startup preserves the active worker precache");
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
