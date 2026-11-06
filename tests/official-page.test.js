"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns/promises');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { readOfficialPage } = require('../scripts/delayed-releases');

test('official requests pin validated DNS and reject private redirects without connecting', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unpinned fetch is forbidden'); });
  let resolutions = 0, connections = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  t.mock.method(https, 'request', (url, options, callback) => {
    connections++;
    assert.equal(url.hostname, 'official.example');
    assert.equal(typeof options.lookup, 'function');
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
    });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location: 'https://rebound.example/news' };
      callback(response); response.end();
    });
    return request;
  });
  await assert.rejects(readOfficialPage('https://official.example/news'), /no público/);
  assert.equal(connections, 1); assert.equal(resolutions, 2);
});

test('each public redirect pins its own validated address and supports lookup all mode', async t => {
  const addresses = ['93.184.216.34', '93.184.216.35'];
  let resolutions = 0, connections = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: addresses[resolutions++], family: 4 }]);
  t.mock.method(https, 'request', (url, options, callback) => {
    const index = connections++;
    options.lookup(url.hostname, { all: true }, (error, result) => {
      assert.equal(error, null);
      assert.deepEqual(result, [{ address: addresses[index], family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = index === 0 ? 302 : 200;
      response.headers = index === 0 ? { location: 'https://second.example/news' } : { 'content-type': 'text/html' };
      callback(response); response.end(index === 0 ? '' : '<h1>Official news</h1>');
    });
    return request;
  });
  assert.deepEqual(await readOfficialPage('https://first.example/news'), { html: '<h1>Official news</h1>', url: 'https://second.example/news' });
  assert.equal(resolutions, 2); assert.equal(connections, 2);
});

for (const scenario of ['private', 'oversize', 'redirect-limit', 'non-https']) {
  test(`official transport retains protection: ${scenario}`, async t => {
    let connections = 0;
    t.mock.method(dns, 'lookup', async () => [{ address: scenario === 'private' ? '10.0.0.1' : '93.184.216.34', family: 4 }]);
    t.mock.method(https, 'request', (_url, _options, callback) => {
      connections++;
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = scenario === 'redirect-limit' ? 302 : 200;
        response.headers = { 'content-type': 'text/html', location: '/again' };
        callback(response);
        response.end(Buffer.alloc(scenario === 'oversize' ? 1500001 : 0));
      });
      return request;
    });
    await assert.rejects(readOfficialPage(`${scenario === 'non-https' ? 'http' : 'https'}://official.example/news`),
      scenario === 'oversize' ? /demasiado grande/ : scenario === 'redirect-limit' ? /Demasiadas redirecciones/ : /no públic/);
    assert.equal(connections, scenario === 'redirect-limit' ? 4 : scenario === 'oversize' ? 1 : 0);
  });
}
