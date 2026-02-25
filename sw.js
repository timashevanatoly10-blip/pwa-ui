// sw.js — SAFE CACHE STRATEGY (no API caching, no non-GET caching)

const CACHE_NAME = "tim-cache-v2";

// Предкэш (только реально статичное)
const PRECACHE_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_ASSETS);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

// НИКОГДА не кэшируем API и НЕ-GET
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Только свой origin
  if (url.origin !== self.location.origin) return;

  // 1) Не-GET: только сеть (иначе POST/DELETE/PATCH ломаются)
  if (req.method !== "GET") {
    event.respondWith(fetch(req));
    return;
  }

  // 2) API: строго сеть, без кэша
  if (isApiPath(url.pathname)) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  // 3) Навигация (HTML): network-first + кладём в кэш (офлайн-фоллбек)
  if (req.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(req));
    return;
  }

  // 4) Статика: cache-first (только то, что похоже на asset)
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 5) Всё прочее: сеть (и не кэшируем, чтобы не ловить сюрпризы)
  event.respondWith(fetch(req));
});

function isApiPath(pathname) {
  return (
    pathname === "/chat" ||
    pathname.startsWith("/db/") ||
    pathname === "/puchki" ||
    pathname.startsWith("/puchki/") ||
    pathname.startsWith("/items") ||
    pathname.startsWith("/telegram/")
  );
}

function isStaticAsset(pathname) {
  // Всё из /assets/ считаем статикой
  if (pathname.startsWith("/assets/")) return true;

  // Иконки/манифест
  if (pathname === "/manifest.webmanifest") return true;
  if (pathname.startsWith("/icon-")) return true;

  // Типовые расширения статики
  return /\.(css|js|png|jpg|jpeg|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(pathname);
}

async function navigationNetworkFirst(req) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const fresh = await fetch(req, { cache: "no-store" });

    // Кэшируем успешную “навигацию” (обычно это / или /index.html)
    if (fresh && fresh.ok && fresh.type === "basic") {
      cache.put(req, fresh.clone());
    }

    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;

    // Фоллбек: попробуем / (часто start_url)
    const cachedRoot = await cache.match("/");
    if (cachedRoot) return cachedRoot;

    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);

  const cached = await cache.match(req);
  if (cached) return cached;

  const fresh = await fetch(req);

  // Кэшируем только нормальные успешные same-origin ответы
  if (fresh && fresh.ok && fresh.type === "basic") {
    cache.put(req, fresh.clone());
  }

  return fresh;
}
