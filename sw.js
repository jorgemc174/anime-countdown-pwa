const CACHE_NAME = "anime-countdown-pwa-v96";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=96",
  "./config.js?v=96",
  "./app.js?v=96",
  "./manifest.json",
  "./favicon.ico"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients.openWindow ? self.clients.openWindow(url) : Promise.resolve()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith("/schedule.json")) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    await putInCache(request, response.clone());
    return response;
  } catch (_) {
    if (request.mode === "navigate") return caches.match("./index.html");
    return Response.error();
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(request, response.clone());
    return response;
  } catch (_) {
    return await caches.match(request) || Response.error();
  }
}

async function putInCache(request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}
