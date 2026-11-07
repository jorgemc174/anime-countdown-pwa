"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { validatePublish, main } = require("../scripts/validate-publish");
const { assertScheduleNotDegraded } = require("../scripts/sync-animeschedule");
const { seriesKey } = require("../platform-policy");
const { enrichPlatforms } = require("../scripts/enrich-platforms");
const now = Date.parse("2026-11-07T12:00:00Z");
const record = { status: "verified", checkedAt: new Date(now).toISOString(), offers: [{ service: "Netflix", url: "https://www.netflix.com/title/1" }] };
const row = { title: "Sample", animeKey: "sample", episodeNumber: 1, releaseDate: "2026-11-08T18:00:00Z", platformsByCountry: { ES: record } };
const schedule = { releases: [row], platforms: { coverage: { ES: { verified: 1 } } } };
const cache = { version: 1, series: { sample: { countries: { ES: record } } } };
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anime-publish-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("schedule guard allows a natural 15% loss, counts only the requested future window, and eventually unlocks", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...row, animeKey: `show-${i}` }));
  const opts = { now, weeks: [{ year: 2026, week: 45 }] };
  assert.doesNotThrow(() => assertScheduleNotDegraded({ releases: rows }, rows.slice(15), opts));
  assert.throws(() => assertScheduleNotDegraded({ releases: rows }, rows.slice(99), opts), /degradado/);
  assert.doesNotThrow(() => assertScheduleNotDegraded({ releases: rows.slice(0, 5) }, [row], opts));
  const expired = rows.map(item => ({ ...item, releaseDate: "2026-11-01T18:00:00Z" }));
  const outside = rows.map(item => ({ ...item, releaseDate: "2026-11-22T18:00:00Z" }));
  assert.doesNotThrow(() => assertScheduleNotDegraded({ releases: [...expired, ...outside, row] }, [row], opts));
  assert.doesNotThrow(() => assertScheduleNotDegraded({ releases: rows }, [], { ...opts, now: Date.parse("2026-11-09T00:00:00Z") }));
});

test("platform guard permits individual removals and excludes shows absent from the schedule", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...row, animeKey: `show-${i}` }));
  const previous = { ...record, pendingNegative: { firstSeenAt: new Date(now - 4 * 3600000).toISOString() } };
  const previousCache = { version: 1, series: Object.fromEntries(rows.map(item => [seriesKey(item), { countries: { ES: previous } }])) };
  const result = await enrichPlatforms({ releases: rows }, previousCache, { now, concurrency: 20,
    lookup: async item => Number(item.animeKey.split("-")[1]) < 3 ? { status: "no-offers", offers: [] } : record });
  assert.equal(result.summary.coverage.ES.verified, 17);
  const few = await enrichPlatforms({ releases: rows.slice(0, 2) }, previousCache, { now, concurrency: 2, lookup: async () => ({ status: "no-offers", offers: [] }) });
  assert.equal(few.summary.coverage.ES.verified, 0);
});

test("publish validation accepts valid files and rejects malformed, stale or inconsistent data", async t => {
  assert.equal(validatePublish(schedule, cache, now).future, 1);
  const invalids = [
    [{}, cache], [{ ...schedule, releases: [{ ...row, releaseDate: "bad" }] }, cache],
    [{ ...schedule, releases: [{ ...row, releaseDate: "2020-01-01T00:00:00Z" }] }, cache],
    [schedule, {}], [schedule, { ...cache, series: [] }],
    [{ ...schedule, platforms: undefined }, cache],
    [schedule, { ...cache, series: {} }],
    [schedule, { ...cache, series: { sample: { countries: { ES: { ...record, offers: [] } } } } }],
    [schedule, { ...cache, series: { sample: { countries: { ES: { ...record, offers: [{ service: "Netflix", url: "http://bad.example" }] } } } } }],
    [schedule, { ...cache, series: { sample: { countries: { MX: record } } } }]
  ];
  for (const [input, records] of invalids) assert.throws(() => validatePublish(input, records, now));
  const dir = await temp(t);
  const future = { ...schedule, releases: [{ ...row, releaseDate: new Date(Date.now() + 86400000).toISOString() }] };
  await fs.writeFile(path.join(dir, "schedule.json"), JSON.stringify(future));
  await fs.writeFile(path.join(dir, "platform-cache.json"), JSON.stringify(cache));
  await main(dir);
  await fs.writeFile(path.join(dir, "platform-cache.json"), "{");
  await assert.rejects(main(dir), SyntaxError);
  await fs.writeFile(path.join(dir, "platform-cache.json"), "{}");
  await assert.rejects(main(dir), /inválida/);
});

for (const scenario of ["outage", "totalFailure", "exception", "allowed-drop"]) test(`enrichment CLI preserves a new timetable and validates only completed enrichment: ${scenario}`, async t => {
  const dir = await temp(t);
  await fs.mkdir(path.join(dir, "scripts"));
  for (const file of ["scripts/enrich-platforms.js", "schedule-policy.js", "platform-policy.js"]) await fs.copyFile(path.join(__dirname, "..", file), path.join(dir, file));
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...row, animeKey: `show-${i}`, releaseDate: new Date(Date.now() + 86400000).toISOString() }));
  const records = { version: 1, series: Object.fromEntries(rows.map(item => [seriesKey(item), { countries: { ES: { ...record,
    checkedAt: new Date(Date.now() - 24 * 3600000).toISOString(), pendingNegative: { firstSeenAt: new Date(Date.now() - 4 * 3600000).toISOString() } } } }])) };
  const files = { "schedule.json": JSON.stringify({ updatedAt: "new-timetable", releases: rows.map(item => ({ ...item, episodeNumber: 2, platformsByCountry: undefined })) }), "platform-cache.json": JSON.stringify(records) };
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(dir, file), content);
  await fs.writeFile(path.join(dir, "hook.cjs"), `require('node:timers/promises').setTimeout = async () => {}; global.fetch = async () => ${scenario === "totalFailure" ? "new Response('{}', {status:429})" : "Response.json({data:{popularTitles:{edges:[]},Media:null}})"};`);
  const env = { ...process.env, JUSTWATCH_COUNTRIES: scenario === "exception" ? "INVALID" : "ES", RUNNER_TEMP: dir, ALLOW_DATA_DROP: String(scenario === "allowed-drop") };
  const run = execFile(process.execPath, ["--require", "./hook.cjs", "scripts/enrich-platforms.js"], { cwd: dir, env });
  if (scenario === "allowed-drop") {
    const output = await run;
    assert.match(output.stderr, /::warning::/);
  } else await assert.rejects(run, error => error.code === 1);
  const updated = JSON.parse(await fs.readFile(path.join(dir, "schedule.json"), "utf8"));
  const updatedCache = JSON.parse(await fs.readFile(path.join(dir, "platform-cache.json"), "utf8"));
  assert.equal(updated.updatedAt, "new-timetable");
  assert.equal(updated.releases.length, rows.length);
  assert.ok(updated.releases.every(item => item.episodeNumber === 2));
  if (scenario === "exception") {
    assert.equal(updated.platforms, undefined);
    assert.throws(() => validatePublish(updated, updatedCache), /actualización válida/);
    for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(dir, file), "utf8"), content);
  } else {
    assert.doesNotThrow(() => validatePublish(updated, updatedCache));
    assert.equal(updated.platforms.coverage.ES.verified, scenario === "allowed-drop" ? 0 : rows.length);
    if (scenario === "outage") {
      assert.ok(updated.platforms.degraded);
      for (const [key, entry] of Object.entries(records.series)) assert.deepEqual(updatedCache.series[key].countries.ES, entry.countries.ES);
    }
    if (scenario === "totalFailure") assert.equal(updated.platforms.totalFailure, true);
    if (scenario === "allowed-drop") assert.ok(!updated.platforms.degraded);
  }
});

function runBlock(workflow, name) {
  return workflow.split(`      - name: ${name}\n`)[1].split("        run: |\n")[1].split(/\n      - /)[0].split("\n").map(line => line.replace(/^          /, "")).join("\n");
}
test("workflows gate commits and APK publication, and reject absent keys or wrong certificates", async t => {
  const update = await fs.readFile(path.join(__dirname, "../.github/workflows/update-schedule.yml"), "utf8");
  assert.ok(update.indexOf("node scripts/validate-publish.js") < update.indexOf("git commit"));
  assert.match(update, /name: Validate data before publishing\n\s+id: validate\n\s+if:.*steps.platforms.outcome != 'skipped'/);
  assert.match(update, /name: Commit updated schedule\n\s+if:.*steps.validate.outcome == 'success'/);
  assert.doesNotMatch(update, /steps.platforms.outcome == 'success'/);
  assert.match(update, /if \(platforms.degraded\).*::error::/);
  assert.match(update, /allow_data_drop:\n\s+description:.*\n\s+type: boolean\n\s+default: false/);
  assert.equal((update.match(/ALLOW_DATA_DROP: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.allow_data_drop \|\| false \}\}/g) || []).length, 2);
  assert.match(update, /name: Prepare shared regional platforms\n\s+id: platforms\n\s+if:.*steps.generate.outcome != 'skipped'/);
  assert.match(update, /name: Report update result\n\s+if: always\(\)/);
  assert.match(update, /keep-enabled:\n\s+needs: update\n\s+if: always\(\)/);
  const workflow = await fs.readFile(path.join(__dirname, "../.github/workflows/build-apk.yml"), "utf8");
  assert.doesNotMatch(workflow, /assembleDebug|app-debug.apk/);
  assert.match(workflow, /publish:\n\s+needs: apk/);
  const dir = await temp(t);
  const build = runBlock(workflow, "Build APK");
  for (const credentials of [{ KEYSTORE_BASE64: "", ANDROID_KEYSTORE_PASSWORD: "" }, { KEYSTORE_BASE64: "placeholder", ANDROID_KEYSTORE_PASSWORD: "" }]) {
    await assert.rejects(execFile("bash", ["-e", "-o", "pipefail", "-c", build], { cwd: dir, env: { ...process.env, ...credentials } }), error => error.code === 1 && /Falta la clave/.test(error.stdout));
  }
  const expected = workflow.match(/ANDROID_CERT_SHA256: ([a-f0-9]{64})/)[1];
  const sdk = path.join(dir, "build-tools/34.0.0");
  await fs.mkdir(sdk, { recursive: true });
  await fs.writeFile(path.join(sdk, "apksigner"), '#!/bin/bash\nprintf "Signer #1 certificate SHA-256 digest: %s\\n" "$MOCK_CERT"\n', { mode: 0o755 });
  await fs.writeFile(path.join(sdk, "aapt"), '#!/bin/bash\necho "versionCode=\'123\'"\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, "AniCountdown.apk"), "fixture");
  const verify = runBlock(workflow, "Verify APK signature and package");
  const env = { ...process.env, RUNNER_TEMP: dir, ANDROID_HOME: dir, APP_VERSION_CODE: "123", ANDROID_CERT_SHA256: expected };
  await assert.rejects(execFile("bash", ["-e", "-o", "pipefail", "-c", verify], { env: { ...env, MOCK_CERT: "0".repeat(64) } }), error => error.code === 1 && /no coincide/.test(error.stdout));
  await execFile("bash", ["-e", "-o", "pipefail", "-c", verify], { env: { ...env, MOCK_CERT: expected } });
});

test("the schedule guard only allows a massive drop with the explicit true override", t => {
  const previous = process.env.ALLOW_DATA_DROP;
  t.after(() => { if (previous === undefined) delete process.env.ALLOW_DATA_DROP; else process.env.ALLOW_DATA_DROP = previous; });
  const warnings = t.mock.method(console, "warn", () => {});
  const rows = Array.from({ length: 100 }, () => row);
  const options = { now, weeks: [{ year: 2026, week: 45 }] };
  for (const value of ["false", "1", "TRUE"]) {
    process.env.ALLOW_DATA_DROP = value;
    assert.throws(() => assertScheduleNotDegraded({ releases: rows }, [row], options), /degradado/);
  }
  process.env.ALLOW_DATA_DROP = "true";
  assert.doesNotThrow(() => assertScheduleNotDegraded({ releases: rows }, [row], options));
  assert.match(warnings.mock.calls[0].arguments[0], /::warning::/);
});
