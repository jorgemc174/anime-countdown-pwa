const CACHE_NAME = "anime-countdown-pwa-v75";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=75",
  "./config.js?v=75",
  "./app.js?v=75",
  "./schedule.json",
  "./manifest.json",
  "./favicon.ico",
  "./icons/favicon.ico",
  "./icons/favicon-16.png",
  "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/notification-badge.svg",
  "./icons/icon-256.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-mobile-192.png",
  "./icons/icon-mobile-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
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

  event.respondWith(
    fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    }).catch(() => {
      return caches.match(request).then((cached) => cached || caches.match("./index.html"));
    })
  );
});
