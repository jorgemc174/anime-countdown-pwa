"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vercel = require('../vercel.json');

test('Vercel carries static host security headers and preserves resource cache policies', () => {
  const shared = fs.readFileSync(require.resolve('../_headers'), 'utf8').split('\n\n')[0]
    .split('\n').slice(1).map(line => line.trim().split(/: (.*)/s).slice(0, 2));
  const global = vercel.headers.find(row => row.source === '/(.*)').headers;
  for (const [key, value] of shared) assert.ok(global.some(header => header.key === key && header.value === value), key);
  assert.ok(!global.some(header => header.key.toLowerCase() === 'content-security-policy'));
  const header = (source, key) => vercel.headers.find(row => row.source === source).headers.find(row => row.key === key).value;
  assert.equal(header('/api/(.*)', 'Cache-Control'), 'no-store');
  assert.equal(header('/sw.js', 'Cache-Control'), 'no-cache');
  assert.equal(header('/index.html', 'Cache-Control'), 'no-cache');
  assert.equal(header('/schedule.json', 'Access-Control-Allow-Origin'), '*');
  assert.equal(header('/schedule.json', 'Cache-Control'), 'public, max-age=0, must-revalidate');
  for (const source of ['/app.js', '/styles.css', '/config.js']) assert.equal(header(source, 'Cache-Control'), 'public, max-age=31536000, immutable');
});
