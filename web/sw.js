/*
 * 只快取介面外殼。誠實原則:辨識需要網路與後端,離線時只有介面會開,字幕不會有。
 * 所以 /transcribe 與 /health 一律直通網路,絕不進快取。
 */
// ponytail: 外殼走 cache-first,所以改了 index.html / app.js / styles.css 就要把版號往上加一,
// 否則舊使用者拿到的還是舊快取。天花板:沒有內容 hash、沒有建置步驟,換版號是唯一的發佈動作。
const CACHE = 'taigi-caption-v6';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/transcribe') || url.pathname.endsWith('/health')) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || fetch(req))
      .catch(() => caches.match('index.html'))   // 離線又沒中:至少把外殼給出去
  );
});
