// Service Worker for nodelink.js Managerera Manager PWA
// Provides offline caching for static assets

const CACHE_NAME = "nodelink-v1";
const STATIC_ASSETS = [
    "/",
    "/static/",
    "/static/index.html",
];

// Install event - cache static assets
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    // Activate immediately
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    // Take control of all pages immediately
    self.clients.claim();
});

// Fetch event - network first, fallback to cache for static assets
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Don't cache API requests or WebSocket connections
    if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/ws") ||
        event.request.method !== "GET"
    ) {
        return;
    }

    // For static assets, use stale-while-revalidate strategy
    if (url.pathname.startsWith("/static/")) {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    const fetchPromise = fetch(event.request)
                        .then((networkResponse) => {
                            if (networkResponse.ok) {
                                cache.put(event.request, networkResponse.clone());
                            }
                            return networkResponse;
                        })
                        .catch(() => cachedResponse);

                    return cachedResponse || fetchPromise;
                });
            })
        );
        return;
    }

    // For navigation requests, try network first then fall back to cached index
    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match("/static/index.html") || caches.match("/");
            })
        );
        return;
    }
});

// Handle messages from the main thread
self.addEventListener("message", (event) => {
    if (event.data === "skipWaiting") {
        self.skipWaiting();
    }
});
