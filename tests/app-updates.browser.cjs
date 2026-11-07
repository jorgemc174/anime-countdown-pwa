"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const latestUrl = "https://api.github.com/repos/jorgemc174/anime-countdown-pwa/releases/latest";
const downloadUrl = "https://github.com/jorgemc174/anime-countdown-pwa/releases/latest/download/AniCountdown.apk";
module.exports = async ({ scenario, base, ready }) => {
  async function mock(page, options = {}) {
    await page.addInitScript(({ latestUrl, options }) => {
      window.updateTest = { version: localStorage.getItem("testInstalledVersion") || options.version || "1.0.24", reply: { tag_name: options.tag || "v1.0.25" }, requests: [], listeners: {}, mode: "ok", infoCalls: 0 };
      if (options.native !== false) window.Capacitor = { isNativePlatform: () => true, getPlatform: () => options.platform || "android", Plugins: { App: {
        getInfo: async () => { updateTest.infoCalls++; if (updateTest.mode === "info-error") throw new Error("unavailable"); return { version: updateTest.version }; },
        addListener: async (name, fn) => { updateTest.listeners[name] = fn; return { remove() {} }; }, exitApp() {}
      } } };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (String(input) !== latestUrl) return originalFetch(input, init);
        updateTest.requests.push({ url: String(input), headers: { ...init.headers }, credentials: init.credentials, referrerPolicy: init.referrerPolicy });
        if (updateTest.mode === "network") throw new TypeError("offline");
        return { ok: updateTest.mode !== "status", status: updateTest.mode === "status" ? 429 : 200, json: async () => { if (updateTest.mode === "json") throw new SyntaxError("invalid JSON"); return updateTest.reply; } };
      };
    }, { latestUrl, options });
    await page.goto(base); await ready(page);
    if (options.native !== false && (options.platform || "android") === "android") {
      await page.waitForFunction(() => typeof checkForAppUpdate === "function" && updateCheckPromise === null && Boolean(updateTest.listeners.appStateChange));
    }
  }
  for (const [installed, published, newer] of [["1.0.24", "v1.0.25", true], ["1.0.25", "v1.0.25", false], ["1.0.26", "1.0.25", false], ["1.0.9", "v1.0.10", true], ["1.1.0", "v1.0.99", false]]) {
    await scenario(`F12 numeric versions ${installed} against ${published}`, async page => {
      await mock(page, { version: installed, tag: published });
      assert.equal(await page.locator("#updateNotice").isVisible(), newer);
      assert.equal(await page.locator("#installedAppVersion").textContent(), `Versión instalada: ${installed}`);
      if (newer) assert.equal(await page.locator("#updateNoticeText").textContent(), `Hay una versión nueva (${published.replace(/^v/, "")})`);
      const requests = await page.evaluate(() => updateTest.requests);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0], { url: latestUrl, headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" });
      assert.ok(await page.evaluate(() => Number.isFinite(Date.parse(JSON.parse(localStorage.getItem("animeCountdownStorage")).lastUpdateCheck))));
    });
  }
  await scenario("F12 daily throttle, simultaneous foreground events and cached banner", async page => {
    await mock(page);
    await page.reload(); await ready(page);
    await page.waitForFunction(() => updateCheckPromise === null && Boolean(updateTest.listeners.appStateChange));
    assert.equal(await page.evaluate(() => updateTest.requests.length), 0);
    assert.equal(await page.locator("#updateNotice").isVisible(), true);
    await page.clock.pauseAt("2026-10-30T12:00:10Z");
    const remaining = await page.evaluate(() => Date.parse(state.lastUpdateCheck) + 24 * 3600000 - Date.now());
    await page.clock.fastForward(remaining - 1);
    await page.evaluate(() => updateTest.listeners.appStateChange({ isActive: true }));
    await page.waitForFunction(() => updateCheckPromise === null);
    assert.equal(await page.evaluate(() => updateTest.requests.length), 0);
    await page.clock.fastForward(1);
    await page.evaluate(() => {
      updateTest.listeners.appStateChange({ isActive: false });
      updateTest.listeners.appStateChange({ isActive: true });
      updateTest.listeners.appStateChange({ isActive: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => updateCheckPromise === null);
    assert.equal(await page.evaluate(() => updateTest.requests.length), 1);
  });
  await scenario("F12 later persists per version, newer returns and download uses external opening", async page => {
    await mock(page);
    await page.getByRole("button", { name: "Más tarde", exact: true }).click();
    assert.equal(await page.locator("#updateNotice").isVisible(), false);
    assert.equal(await page.locator("#showAllBtn").evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => storageWriteQueue);
    await page.reload(); await ready(page);
    await page.waitForFunction(() => updateCheckPromise === null && Boolean(updateTest.listeners.appStateChange));
    assert.equal(await page.locator("#updateNotice").isVisible(), false);
    assert.equal(await page.locator("#availableAppVersion").textContent(), "Nueva versión disponible: 1.0.25");
    await page.clock.fastForward(24 * 3600000);
    await page.evaluate(() => { updateTest.reply = { tag_name: "v1.0.26" }; updateTest.listeners.appStateChange({ isActive: true }); });
    await page.waitForFunction(() => updateCheckPromise === null && state.latestUpdateVersion === "1.0.26");
    assert.equal(await page.locator("#updateNotice").isVisible(), true);
    assert.equal(await page.locator("#updateNoticeText").textContent(), "Hay una versión nueva (1.0.26)");
    await page.evaluate(() => { window.externalOpens = []; window.open = (...args) => externalOpens.push(args); });
    await page.getByRole("button", { name: "Descargar", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => externalOpens), [[downloadUrl, "_system"]]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("animeCountdownStorage")).dismissedUpdateVersion), "1.0.25");
    await page.evaluate(() => localStorage.setItem("testInstalledVersion", "1.0.26"));
    await page.reload(); await ready(page);
    await page.waitForFunction(() => updateCheckPromise === null && Boolean(state.installedAppVersion));
    assert.equal(await page.locator("#updateNotice").isVisible(), false);
  });
  await scenario("F12 errors, malformed versions and rate limits are silent and retry after a day", async page => {
    const errors = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await mock(page, { tag: "v1.0.24" });
    const cases = [{ mode: "network" }, { mode: "status" }, { mode: "json" }, { reply: null }, { reply: [] }, { reply: { tag_name: 125 } }, { reply: { tag_name: "v1.0.25-beta" } }, { reply: { tag_name: "<script>" } }, { version: "unknown" }, { mode: "info-error" }];
    for (const test of cases) {
      await page.evaluate(async test => {
        Object.assign(updateTest, { mode: "ok", reply: { tag_name: "v1.0.25" }, version: "1.0.24" }, test);
        state.lastUpdateCheck = ""; state.latestUpdateVersion = ""; state.installedAppVersion = "";
        renderAppUpdateNotice();
        await checkForAppUpdate();
      }, test);
      assert.equal(await page.locator("#updateNotice").isVisible(), false);
    }
    await page.evaluate(async () => {
      updateTest.version = "1.0.24"; updateTest.mode = "network"; state.lastUpdateCheck = "";
      await checkForAppUpdate(); updateTest.requests = [];
      updateTest.mode = "ok";
      updateTest.listeners.appStateChange({ isActive: true });
    });
    await page.waitForFunction(() => updateCheckPromise === null);
    assert.equal(await page.evaluate(() => updateTest.requests.length), 0);
    await page.clock.fastForward(24 * 3600000);
    await page.evaluate(() => updateTest.listeners.appStateChange({ isActive: true }));
    await page.waitForFunction(() => updateCheckPromise === null);
    assert.equal(await page.locator("#updateNotice").isVisible(), true);
    assert.deepEqual(errors, []);
    await page.evaluate(async () => { delete Capacitor.Plugins.App.getInfo; state.lastUpdateCheck = ""; state.latestUpdateVersion = ""; renderAppUpdateNotice(); await checkForAppUpdate(); });
    assert.equal(await page.locator("#updateNotice").isVisible(), false);
  });
  for (const platform of ["web", "ios"]) {
    await scenario(`F12 no requests or version UI on ${platform}`, async page => {
      await mock(page, { native: platform !== "web", platform });
      await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
      assert.equal(await page.evaluate(() => updateTest.requests.length), 0);
      assert.equal(await page.evaluate(() => updateTest.infoCalls), 0);
      assert.equal(await page.locator("#updateNotice").isVisible(), false);
      await page.locator("#settingsBtn").click();
      assert.equal(await page.locator("#appVersionStatus").isVisible(), false);
    });
  }
  await scenario("F12 accessible banner and settings fit 360px in both themes", async page => {
    await mock(page);
    await page.setViewportSize({ width: 360, height: 800 });
    fs.mkdirSync("/tmp/f12-screenshots", { recursive: true });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { applyTheme(theme); setMode("all"); }, theme);
      await page.screenshot({ path: `/tmp/f12-screenshots/360-${theme}.png`, animations: "disabled" });
      assert.equal(await page.locator("#updateNotice").getAttribute("role"), "status");
      assert.equal(await page.locator("#updateNotice").evaluate(el => el.getBoundingClientRect().height < 110), true);
      assert.equal(await page.locator("#updateNotice button").evaluateAll(nodes => nodes.every(el => { const r = el.getBoundingClientRect(); return r.height >= 44 && r.width >= 44; })), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && $("updateNotice").getBoundingClientRect().bottom <= $("animeList").getBoundingClientRect().top), true);
      await page.locator("#settingsBtn").click();
      await page.locator("#settingsPanel").evaluate(el => el.scrollTop = el.scrollHeight);
      assert.equal(await page.locator("#installedAppVersion").isVisible(), true);
      assert.equal(await page.locator("#availableAppVersion").isVisible(), true);
      await page.screenshot({ path: `/tmp/f12-screenshots/360-settings-${theme}.png`, animations: "disabled" });
      await page.locator("#closeSettingsBtn").click();
    }
  });
};
