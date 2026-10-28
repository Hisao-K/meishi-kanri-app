// 名刺管理君アプリの service worker。
// 画面のファイル（HTML・JS・CSS・アイコン）だけを置いておき、電波が弱くてもアプリが開くようにする。
// 名刺のデータ（GASとのやり取り）は別のサイトあてなので、ここでは扱わない・保存しない。
// 画面を更新したら VERSION を上げる。
const VERSION = 'meishi-v8';
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

// 消すのは、このアプリの古い置き場（meishi- で始まるもの）だけ。
// 同じサイト（hisao-k.github.io）にあるほかのアプリ（経費判定君など）の置き場は消さない（2026-10-28）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('meishi-') && k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// このアプリの場所（scope）の GET だけ。新しい画面を優先し、つながらないときだけ置いておいた画面を出す。
// 置いておくのは、正しく届いた応答だけ
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
