"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { build } = require("../scripts/build-www");

test("packaged web includes the worker and all referenced assets, without server or maintenance code", async () => {
  await build();
  const root = path.join(__dirname, "..", "www");
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const worker = await fs.readFile(path.join(root, "sw.js"), "utf8");
  const precache = JSON.parse(worker.match(/const ASSETS = (\[[\s\S]*?\]);/)[1]);
  const references = [...html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)].map(match => match[1]);
  for (const reference of [...precache, ...references]) {
    const filename = reference === "./" ? "index.html" : reference.split("?")[0];
    await fs.access(path.join(root, filename));
  }
  for (const file of ["server.js", "package-lock.json", "scripts", "tests", "node_modules", "api"]) {
    await assert.rejects(fs.access(path.join(root, file)), { code: "ENOENT" });
  }
});
