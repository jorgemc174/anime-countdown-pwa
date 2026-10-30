"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../schedule-policy");
const { normalizeSchedule, reconcileAnimeScheduleWithAnilist } = require("../scripts/sync-animeschedule");
const { extractOfficialEvidence, resolveDelay, trackDelays, privateAddress } = require("../scripts/delayed-releases");

const now = "2026-10-30T12:00:00Z";
const row = { id: "old-id", animeKey: "sample", title: "Sample", episodeNumber: "4", delayed: true, releaseDate: "2026-10-28T18:00:00Z" };
const candidate = { ...row, releaseDate: "2026-11-01T19:30:00Z", scheduleStatus: "pending" };
const evidence = { kind: "official-sub-announcement", url: "https://official.example/news/4", date: "2026-11-01" };
function html(node) { return `<script type="application/ld+json">${JSON.stringify(node)}</script>`; }
const event = { "@type": "BroadcastEvent", startDate: "2026-11-01", subtitleLanguage: "es", workPerformed: { "@type": "TVEpisode", episodeNumber: 4, partOfSeries: { name: "Sample" } } };

test("a nonempty expired schedule is stale", () => {
  assert.equal(policy.health({ releases: [row] }, Date.parse(now)).stale, true);
});
test("pending rows never count as confirmed future dates", () => {
  assert.equal(policy.health({ releases: [candidate] }, Date.parse(now)).future, 0);
  assert.equal(policy.hasConfirmedTime({ ...candidate, scheduleStatus: "scheduled" }), true);
  assert.equal(policy.hasConfirmedTime({ ...candidate, releaseDate: "2026-11-01", scheduleStatus: "scheduled" }), false);
});
test("validate rejects malformed payloads atomically and accepts undated delays", () => {
  for (const payload of [{}, { releases: {} }, { releases: [null] }, { releases: [{ title: "X", releaseDate: "bad" }] }]) {
    assert.throws(() => policy.validate(payload));
  }
  assert.equal(policy.validate({ releases: [{ ...row, releaseDate: null, scheduleStatus: "pending" }] }).length, 1);
});
test("normalization retains indefinite delay, without creating a date", () => {
  const rows = normalizeSchedule([{ title: "Sample", episodeNumber: 4, status: "postponed indefinitely", airType: "sub" }], "Europe/Madrid");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].releaseDate, null);
  assert.equal(rows[0].scheduleStatus, "pending");
});
test("source English aliases are retained for regional platform matching", () => {
  const [item] = normalizeSchedule([{ title: "FX Senshi Kurumi-chan", english: "FX Fighter Kurumi-chan", native: "FX戦士くるみちゃん", episodeNumber: 1, subReleaseDate: "2026-11-01T18:00:00Z" }], "Europe/Madrid");
  assert.ok(item.titles.includes("FX Fighter Kurumi-chan"));
  assert.ok(item.titles.includes("FX戦士くるみちゃん"));
});
test("a date without a SUB hour never becomes a midnight release", () => {
  const [result] = normalizeSchedule([{ title: "Sample", episodeNumber: 4, subReleaseDate: "2026-11-01" }], "Europe/Madrid");
  assert.equal(result.releaseDate, null);
  assert.equal(result.scheduleStatus, "pending");
});
test("AniList cannot move a SUB date or invent episodes", () => {
  const rows = [{ ...candidate, scheduleStatus: "scheduled" }];
  const result = reconcileAnimeScheduleWithAnilist(rows, [{ ...candidate, releaseDate: "2026-11-02T01:00:00Z" }]);
  assert.deepEqual(result, rows);
});
test("an official article publication date or Japanese broadcast is not a SUB announcement", () => {
  assert.deepEqual(extractOfficialEvidence(html({ "@type": "NewsArticle", datePublished: now }), 4, evidence.url), []);
  assert.deepEqual(extractOfficialEvidence(html({ ...event, subtitleLanguage: undefined }), 4, evidence.url), []);
  assert.deepEqual(extractOfficialEvidence(html(event), 5, evidence.url), []);
  assert.deepEqual(extractOfficialEvidence(html(event), 4, evidence.url, ["Another series"]), []);
});
test("structured official evidence matches the exact series and episode", () => {
  assert.equal(extractOfficialEvidence(html(event), 4, evidence.url, ["Sample"])[0].date, "2026-11-01");
});
test("plain official news needs an explicit SUB statement, exact episode and unambiguous date", () => {
  const page = '<title>Sample official news</title><p>Subtitled episode 4 has been rescheduled to 2026-11-01.</p>';
  const entries = extractOfficialEvidence(page, 4, evidence.url, ["Sample"]);
  assert.equal(entries[0].date, "2026-11-01");
  assert.match(entries[0].quote, /Subtitled episode 4/);
  assert.deepEqual(extractOfficialEvidence(page.replace("Subtitled", "Japanese broadcast"), 4, evidence.url, ["Sample"]), []);
  assert.deepEqual(extractOfficialEvidence(page.replace("2026-11-01", "2026-11-01 or 2026-11-02"), 4, evidence.url, ["Sample"]), []);
});
test("without official evidence, a delayed episode has no date or countdown", () => {
  const result = resolveDelay(row, candidate, [], now);
  assert.equal(result.scheduleStatus, "pending");
  assert.equal(result.releaseDate, null);
  assert.equal(result.originalReleaseDate, row.releaseDate);
});
test("an official date without a fresh AnimeSchedule time remains date-only", () => {
  const result = resolveDelay(row, null, [evidence], now);
  assert.equal(result.scheduleStatus, "date-confirmed");
  assert.equal(result.confirmedSubDate, "2026-11-01");
  assert.equal(result.releaseDate, null);
});
test("past official announcements cannot revive an obsolete date", () => {
  const result = resolveDelay(row, candidate, [{ ...evidence, date: "2026-10-20" }], now);
  assert.equal(result.scheduleStatus, "pending");
  assert.equal(result.confirmedSubDate, "");
  assert.equal(result.releaseDate, null);
});
test("AnimeSchedule local SUB times respect summer and winter offsets", () => {
  const rows = normalizeSchedule([
    { title: "Before", episodeNumber: 1, subReleaseDate: "2026-10-24T18:00:00" },
    { title: "After", episodeNumber: 1, subReleaseDate: "2026-10-25T18:00:00" }
  ], "Europe/Madrid");
  assert.equal(rows[0].releaseDate, "2026-10-24T16:00:00.000Z");
  assert.equal(rows[1].releaseDate, "2026-10-25T17:00:00.000Z");
});
test("rescheduling uses the exact AnimeSchedule timestamp, not the official announcement hour", () => {
  const result = resolveDelay(row, candidate, [{ ...evidence, date: "2026-11-01T07:00:00+09:00" }], now);
  // This Japanese instant is October 31 in Madrid: it cannot confirm November 1 SUB.
  assert.equal(result.scheduleStatus, "conflict");
  const confirmed = resolveDelay(row, candidate, [evidence], now);
  assert.equal(confirmed.scheduleStatus, "rescheduled");
  assert.equal(confirmed.releaseDate, candidate.releaseDate);
  assert.equal(confirmed.id, row.id);
});
test("contradictory announcements suppress dates and notifications", () => {
  const result = resolveDelay(row, candidate, [evidence, { ...evidence, date: "2026-11-02" }], now);
  assert.equal(result.scheduleStatus, "conflict");
  assert.equal(policy.hasConfirmedTime(result), false);
});
test("official cancellation is terminal and has no release time", () => {
  const entries = extractOfficialEvidence(html({ ...event, eventStatus: "https://schema.org/EventCancelled" }), 4, evidence.url, ["Sample"]);
  const result = resolveDelay(row, candidate, entries, now);
  assert.equal(result.scheduleStatus, "cancelled");
  assert.equal(result.releaseDate, null);
});
test("pending episodes survive outside the timetable window and are checked again", async () => {
  let checks = 0;
  const options = { now, discoverSources: async () => { checks++; return []; } };
  const first = await trackDelays([row], [], options);
  const second = await trackDelays(first, [], { ...options, now: "2026-11-10T12:00:00Z" });
  assert.equal(second.length, 1);
  assert.equal(second[0].id, row.id);
  assert.equal(second[0].lastDelayCheck, "2026-11-10T12:00:00Z");
  assert.equal(checks, 2);
});
test("transport failures are distinguished from a successful search without confirmation", async () => {
  const [result] = await trackDelays([row], [], { now, discoverSources: async () => { throw new Error("offline"); } });
  assert.equal(result.delayResearchStatus, "error");
  assert.equal(result.releaseDate, null);
});
test("a successful official check can resolve the retained episode", async () => {
  const [result] = await trackDelays([row], [{ ...candidate, id: "new-upstream-id" }], {
    now, discoverSources: async () => [evidence.url], readPage: async url => ({ url, html: html(event) })
  });
  assert.equal(result.scheduleStatus, "rescheduled");
  assert.equal(result.releaseDate, candidate.releaseDate);
  assert.equal(result.id, row.id);
});
test("private and loopback official destinations are blocked", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress("8.8.8.8"), false);
});
