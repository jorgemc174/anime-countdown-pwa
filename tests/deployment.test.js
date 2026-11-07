"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

// The deployment uses only *, literal paths, directory rules and ! exceptions.
// Check ancestors too: an exception cannot restore a file in an ignored directory.
function exclusionChecker(source) {
  const rules = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  function ignored(filename) {
    let excluded = false;
    for (const rule of rules) {
      const negative = rule.startsWith("!");
      const pattern = (negative ? rule.slice(1) : rule).replace(/^\//, "").replace(/\/$/, "");
      assert.doesNotMatch(pattern, /[?\[\]\\]/, "unsupported ignore pattern");
      const regex = new RegExp("^" + pattern.split("*").map(part => part.replace(/[.+^${}()|]/g, "\\$&")).join("[^/]*") + "$");
      const candidate = pattern.includes("/") ? filename : filename.split("/").at(-1);
      if (regex.test(candidate)) excluded = !negative;
    }
    return excluded;
  }
  return filename => filename.replace(/\/$/, "").split("/").some((_, index, parts) => ignored(parts.slice(0, index + 1).join("/")));
}

test("Vercel publishes every web dependency and excludes internal files by default", () => {
  const excluded = exclusionChecker(read(".vercelignore"));
  const worker = read("sw.js");
  const precache = JSON.parse(worker.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]);
  const references = [...read("index.html").matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)].map(match => match[1]);
  const manifest = JSON.parse(read("manifest.json"));
  const config = { window: {} };
  vm.runInNewContext(read("config.js"), config);
  const notificationIcons = [...read("app.js").matchAll(/["'](\.\/icons\/[^"']+)["']/g)].map(match => match[1]);
  const files = new Set(["index.html", "sw.js", "schedule.json", "manifest.json", "favicon.ico",
    ...precache, ...references, ...manifest.icons.map(icon => icon.src), ...notificationIcons,
    config.window.ANIME_COUNTDOWN_CONFIG.SHARED_SCHEDULE_URL
  ].map(reference => new URL(reference, "https://web.test/").pathname.slice(1) || "index.html"));
  for (const file of files) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
    assert.equal(excluded(file), false, `web dependency excluded: ${file}`);
  }
  for (const file of [".claude/settings.local.json", ".github/workflows/check.yml", "android/app/build.gradle", "plans/audit.md",
    "tests/browser.cjs", "scripts/build-www.js", "node_modules/playwright/package.json", "animeschedule-singlefile-fixed/manifest.json",
    "www/index.html", "server.js", "package.json", "package-lock.json", "capacitor.config.json", "config.example.js",
    "delay-tracking.json", "platform-cache.json", "README.md", "_headers", "api/", "api/anilist.js", "api/anime.js",
    "api/justwatch.js", "api/timetable.js", "future-internal-file.txt", "icons/icon-512 - copia.png"]) {
    assert.equal(excluded(file), true, `internal path published: ${file}`);
  }
  assert.equal(excluded("vercel.json"), false, "deployment configuration must reach Vercel");
  assert.equal(fs.existsSync(path.join(root, "api")), false, "serverless proxies must be removed");
  assert.ok(read(".gitignore").split(/\r?\n/).includes(".claude/"));
});

test("Vercel configuration is valid JSON without API routes or headers", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.ok(Array.isArray(config.headers));
  assert.doesNotMatch(JSON.stringify(config), /\/api/);
});
