"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

test("development server serves the app but denies internal files and traversal", async t => {
  process.env.PORT = "0";
  const server = require("../server");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base + "/api/health")).json(), { ok: true });
  for (const file of ["/", "/app.js", "/schedule-policy.js", "/manifest.json", "/schedule.json", "/icons/favicon.ico"]) {
    assert.equal((await fetch(base + file)).status, 200, file);
  }
  for (const file of ["/.git/config", "/.env", "/server.js", "/package-lock.json", "/scripts/sync-animeschedule.js", "/node_modules/playwright/package.json", "/..%2fanime-countdown-pwa-other/private"]) {
    assert.equal((await fetch(base + file)).status, 403, file);
  }
});
