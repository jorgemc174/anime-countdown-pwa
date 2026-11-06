"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

async function fixture(t, scenario) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anime-generator-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "scripts"));
  for (const file of ["schedule-policy.js", "platform-policy.js", "scripts/sync-animeschedule.js", "scripts/delayed-releases.js", "scripts/enrich-platforms.js"]) {
    await fs.copyFile(path.join(__dirname, "..", file), path.join(dir, file));
  }
  const previous = { updatedAt: "2026-07-22T12:00:00Z", source: "AnimeSchedule", releases: [{ id: "old", title: "Old", releaseDate: "2026-09-01T12:00:00Z" }] };
  await fs.writeFile(path.join(dir, "schedule.json"), JSON.stringify(previous));
  if (["network", "server", "json", "missing"].includes(scenario)) {
    const monday = new Date(); monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() + (8 - (monday.getUTCDay() || 7)));
    previous.releases = [0, 1, 2].map(i => ({ id: `old-${i}`, animeKey: `old-${i}`, title: `Old ${i}`, episodeNumber: 1, airType: "SUB", releaseDate: new Date(+monday + i * 86400000).toISOString() }));
    await fs.writeFile(path.join(dir, "schedule.json"), JSON.stringify(previous));
  }
  const hook = `let calls=0; global.fetch=async (url, options)=>{
    const target=new URL(url);
    if(target.hostname==='apis.justwatch.com') {
      const body=JSON.parse(options.body);
      return Response.json({data:{popularTitles:{edges:[{node:{id:'ts1',objectType:'SHOW',content:{title:'Current'},offers:[{
        package:{technicalName:body.variables.country==='MX'?'hidive':'netflix'},standardWebURL:'https://www.netflix.com/title/test',monetizationType:'FLATRATE'
      }]}}]}}});
    }
    if(target.searchParams.has('api_token')) throw Error('Token in URL');
    if(!options.headers.authorization) throw Error('Missing authorization');
    calls++;
    if (${JSON.stringify(scenario)} === 'auth') return new Response('{}',{status:401});
    if (${JSON.stringify(scenario)} === 'empty') return new Response('[]',{status:200});
    if (['network','server','json','missing'].includes(${JSON.stringify(scenario)})) {
      const monday = new Date(); monday.setUTCHours(0,0,0,0); monday.setUTCDate(monday.getUTCDate() + (8-(monday.getUTCDay()||7)));
      if(calls === 2) {
        if (${JSON.stringify(scenario)} === 'network') throw Error('network down');
        return new Response(${JSON.stringify(scenario)} === 'json' ? '{' : '{}', {status:${JSON.stringify(scenario)} === 'server' ? 503 : ${JSON.stringify(scenario)} === 'missing' ? 404 : 200});
      }
      if(calls>2) return new Response('{}',{status:404});
      return Response.json([{title:'Old 0',route:'old-0',episodeNumber:1,airType:'sub',subReleaseDate:new Date(+monday+3600000).toISOString()}]);
    }
    if(calls>5) return new Response('{}',{status:404});
    return Response.json([{title:'Current',episodeNumber:calls,airType:'sub',subReleaseDate:new Date(Date.now()+calls*86400000).toISOString()}]);
  };`;
  await fs.writeFile(path.join(dir, "hook.cjs"), hook);
  let error, output;
  try { output = await execFile(process.execPath, ["--require", "./hook.cjs", "scripts/sync-animeschedule.js"], {
    cwd: dir, env: { ...process.env, ANIMESCHEDULE_TOKEN: "test-placeholder", INCLUDE_ANILIST_MISSING: "false", ANIMESCHEDULE_RETRIES: "1" }
  }); } catch (failure) { error = failure; }
  if (scenario === "platforms" && !error) {
    await execFile(process.execPath, ["--require", "./hook.cjs", "scripts/enrich-platforms.js"], { cwd: dir, env: { ...process.env, JUSTWATCH_COUNTRIES: "ES,MX" } });
  }
  const schedule = JSON.parse(await fs.readFile(path.join(dir, "schedule.json")));
  return { error, schedule, previous, output };
}
test("five valid weeks and nine future 404s replace an expired timetable", async t => {
  const result = await fixture(t, "partial");
  assert.equal(result.error, undefined);
  assert.equal(result.schedule.releases.length, 5);
  assert.ok(result.schedule.checkedAt);
  assert.notEqual(result.schedule.updatedAt, result.previous.updatedAt);
});
test("authentication rejection fails and preserves the old file", async t => {
  const result = await fixture(t, "auth");
  assert.equal(result.error.code, 1);
  assert.deepEqual(result.schedule, result.previous);
});
test("an empty upstream cannot report success or overwrite the old file", async t => {
  const result = await fixture(t, "empty");
  assert.equal(result.error.code, 1);
  assert.deepEqual(result.schedule, result.previous);
});

test("scheduled pipeline publishes SUB times and precomputed regional platforms in one dataset", async t => {
  const result = await fixture(t, "platforms");
  assert.equal(result.error, undefined);
  assert.equal(result.schedule.platforms.checked, 2);
  for (const item of result.schedule.releases) {
    assert.equal(item.service, "Netflix");
    assert.equal(item.platformsByCountry.ES.offers[0].service, "Netflix");
    assert.equal(item.platformsByCountry.MX.offers[0].service, "HIDIVE");
    assert.ok(Date.parse(item.releaseDate) > Date.now());
  }
});

for (const failure of ["network", "server", "json", "missing"]) {
  test(`failed week retains future episodes, but 404 does not: ${failure}`, async t => {
    const result = await fixture(t, failure);
    assert.equal(result.error, undefined);
    assert.equal(result.schedule.releases.length, failure === "missing" ? 1 : 3);
    assert.equal(result.schedule.releases.filter(row => row.title === "Old 0").length, 1);
    if (failure !== "missing") assert.match(result.output.stderr, /conservad.*2/i);
  });
}
