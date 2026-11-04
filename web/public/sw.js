// Minimal service worker: lets Halaqa Notes open like an app and show a friendly offline page.
// Only public static files are cached. API responses (transcripts, notes) are NEVER cached.
const CACHE = "halaqa-static-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Page loads: always try the network first so updates appear immediately.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || offlinePage())),
    );
    return;
  }

  // Fingerprinted build files and icons: cache-first.
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

function offlinePage() {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:20px system-ui;background:#fbf8f1;color:#1d2320;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><h1 style="font-size:26px">No internet connection</h1><p>Halaqa Notes needs the internet to show your lectures.<br>Please check the Wi-Fi and try again.</p><button onclick="location.reload()" style="font-size:20px;padding:12px 24px;border-radius:12px;border:0;background:#0f5c52;color:#fff">Try again</button></div></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
