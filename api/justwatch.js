"use strict";

const JUSTWATCH_API = "https://apis.justwatch.com/graphql";

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, accept, content-type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const r = await fetch(JUSTWATCH_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    });
    const responseBody = await r.text();
    res
      .status(r.status)
      .setHeader("content-type", r.headers.get("content-type") || "application/json; charset=utf-8")
      .setHeader("cache-control", "no-store")
      .send(responseBody);
  } catch (e) {
    res.status(502).json({ error: e.message || "No se pudo conectar con JustWatch" });
  }
};
