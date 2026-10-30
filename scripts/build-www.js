"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
async function build() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "www");
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const file of ["index.html", "app.js", "schedule-policy.js", "platform-policy.js", "config.js", "styles.css", "sw.js", "schedule.json", "manifest.json", "icons", "_headers"]) {
    await fs.cp(path.join(root, file), path.join(output, file), { recursive: true });
  }
  console.log("www built (web assets only)");
}
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build };
