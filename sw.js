const CACHE_NAME = "tim-cache-v1";

// Что можно кэшировать как "статику"
const ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

// Самое важное: index.html — network-first (чтобы обновлялся)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Только для нашего домена
  if (url.origin !== location.origin) return;

  // Главная страница — всегда сначала сеть
  if (url.pathname === "/" || url.pathname.endsWith("/index.html")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Остальные файлы — cache-first
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    return fresh;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    return cached || new Response("Offline", { status: 503 });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const fresh = await fetch(req);
  // кэшируем только успешные ответы
  if (fresh.ok) cache.put(req, fresh.clone());
  return fresh;
}
