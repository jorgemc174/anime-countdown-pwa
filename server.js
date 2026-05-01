"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5175);
const API_BASE = "https://animeschedule.net/api/v3";
const ANILIST_API = "https://graphql.anilist.co";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      writeCors(res, 204);
      res.end();
      return;
    }

    if (url.pathname === "/api/health") {
      writeCors(res, 200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/anime") {
      await proxyAnimeSchedule(req, res, url, "anime");
      return;
    }

    if (url.pathname === "/api/timetable" || url.pathname === "/api/animeschedule/timetables") {
      await proxyAnimeSchedule(req, res, url, "timetables");
      return;
    }

    if (url.pathname === "/api/anilist") {
      await proxyAnilist(req, res);
      return;
    }

    serveStatic(res, url.pathname);
  } catch (error) {
    writeCors(res, 500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "Error interno" }));
  }
});

async function proxyAnimeSchedule(req, res, url, endpoint) {
  const target = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of url.searchParams) {
    target.searchParams.set(key, value);
  }

  const rawToken = url.searchParams.get("api_token") || "";
  const authorization = rawToken
    ? (rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`)
    : req.headers.authorization || "";

  const response = await fetch(target, {
    headers: {
      accept: "application/json, */*",
      ...(authorization && { authorization })
    }
  });

  const body = await response.arrayBuffer();
  writeCors(res, response.status, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(Buffer.from(body));
}

async function proxyAnilist(req, res) {
  if (req.method !== "POST") {
    writeCors(res, 405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Metodo no permitido" }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");

  const response = await fetch(ANILIST_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body
  });

  const responseBody = await response.text();
  writeCors(res, response.status, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(responseBody);
}

function writeCors(res, status, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, accept, content-type",
    "access-control-allow-private-network": "true",
    ...headers
  });
}

function serveStatic(res, pathname) {
  const cleanPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = path.resolve(ROOT, `.${cleanPath}`);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Anime Countdown listo en http://${HOST}:${PORT}/`);
});
