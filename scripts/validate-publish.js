"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const policy = require("../schedule-policy");
const platforms = require("../platform-policy");

function validatePublish(schedule, cache, now = Date.now()) {
  const rows = policy.validate(schedule);
  if (policy.health(schedule, now).stale) throw new Error("El horario no tiene emisiones futuras confirmadas.");
  if (!cache || cache.version !== 1 || !cache.series || typeof cache.series !== "object" || Array.isArray(cache.series)) {
    throw new Error("Caché de plataformas inválida.");
  }
  if (!schedule.platforms?.coverage?.ES) throw new Error("Falta una actualización válida de plataformas ES.");
  for (const entry of Object.values(cache.series)) {
    if (!entry?.countries || typeof entry.countries !== "object" || Array.isArray(entry.countries)) throw new Error("Países de la caché inválidos.");
    for (const [country, record] of Object.entries(entry.countries)) {
      if (country !== "ES" || !record || !["verified", "no-offers", "not-found", "error", "pending"].includes(record.status) || !Array.isArray(record.offers)) {
        throw new Error("Registro de plataformas inválido.");
      }
      if (record.status === "verified" && (!record.offers.length || !Number.isFinite(Date.parse(record.checkedAt)))) throw new Error("Plataforma verificada sin ofertas o fecha válida.");
      for (const offer of record.offers) {
        let url;
        try { url = new URL(offer.url); } catch { throw new Error("URL de plataforma inválida."); }
        if (!offer.service || url.protocol !== "https:" || url.username || url.password) throw new Error("Oferta de plataforma inválida.");
      }
    }
  }
  for (const row of rows) {
    const records = row.platformsByCountry;
    const cached = cache.series[platforms.seriesKey(row)]?.countries || {};
    if (!records || !isDeepStrictEqual(records, cached)) throw new Error("Horario y caché de plataformas incoherentes.");
  }
  return policy.health(schedule, now);
}

async function main(root = path.resolve(__dirname, "..")) {
  const [schedule, cache] = await Promise.all(["schedule.json", "platform-cache.json"].map(async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"))));
  const health = validatePublish(schedule, cache);
  console.log(`Publicación validada: ${health.future} emisiones futuras.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validatePublish, main };
