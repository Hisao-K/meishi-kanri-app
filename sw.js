// 名刺管理君アプリの service worker。
// 画面のファイル（HTML・JS・CSS・アイコン）だけを置いておき、電波が弱くてもアプリが開くようにする。
// 名刺のデータ（GASとのやり取り）は別のサイトあてなので、ここでは扱わない・保存しない。
// 画面を更新したら VERSION を上げる。
const VERSION = 'meishi-v6';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 同じサイトの GET だけ。新しい画面を優先し、つながらないときだけ置いておいた画面を出す
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
