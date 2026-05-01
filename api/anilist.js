"use strict";

const ANILIST_API = "https://graphql.anilist.co";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const r = await fetch(ANILIST_API, {
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
      .send(responseBody);
  } catch (e) {
    res.status(502).json({ error: e.message || "No se pudo conectar con AniList" });
  }
};
